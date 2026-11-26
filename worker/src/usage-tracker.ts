import type { Env } from "./env";

const STORAGE_KEYS = {
	SITE_ID: "siteId",
	DOMAIN: "domain",
	BANDWIDTH: "bandwidth",
	REQUESTS: "requests",
	CACHE_HITS: "cacheHits",
	CACHE_MISSES: "cacheMisses",
	D1_FAILURES: "d1Failures"
};

const D1_FAILURE_ALERT_THRESHOLD = 5;

interface UsageMetrics {
	siteId: number;
	domain: string;
	bytes: number;
	cacheHit: boolean;
}

export class SiteUsageTracker {
	// In-memory cache of storage values (for performance)
	// These are synced with state.storage on each operation
	siteId = 0;
	domain = "";
	bandwidth = 0;
	requests = 0;
	cacheHits = 0;
	cacheMisses = 0;
	d1Failures = 0;
	initialized = false;

	state: DurableObjectState;
	env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			await this.loadFromStorage();
			const existingAlarm = await this.state.storage.getAlarm();
			if (!existingAlarm && this.env.BILLING_DB) {
				await this.state.storage.setAlarm(Date.now() + 60000);
			}
		});
	}

	/**
	 * Load counters from persistent storage
	 */
	async loadFromStorage(): Promise<void> {
		const stored = await this.state.storage.get([
			STORAGE_KEYS.SITE_ID,
			STORAGE_KEYS.DOMAIN,
			STORAGE_KEYS.BANDWIDTH,
			STORAGE_KEYS.REQUESTS,
			STORAGE_KEYS.CACHE_HITS,
			STORAGE_KEYS.CACHE_MISSES,
			STORAGE_KEYS.D1_FAILURES
		]);
		this.siteId = (stored.get(STORAGE_KEYS.SITE_ID) as number) || 0;
		this.domain = (stored.get(STORAGE_KEYS.DOMAIN) as string) || "";
		this.bandwidth = (stored.get(STORAGE_KEYS.BANDWIDTH) as number) || 0;
		this.requests = (stored.get(STORAGE_KEYS.REQUESTS) as number) || 0;
		this.cacheHits = (stored.get(STORAGE_KEYS.CACHE_HITS) as number) || 0;
		this.cacheMisses = (stored.get(STORAGE_KEYS.CACHE_MISSES) as number) || 0;
		this.d1Failures = (stored.get(STORAGE_KEYS.D1_FAILURES) as number) || 0;
		this.initialized = this.siteId !== 0 || this.domain !== "";
	}

	/**
	 * Receive usage metrics from CDN worker
	 *
	 * Called via ctx.waitUntil - no response needed, async fire-and-forget
	 */
	async fetch(request: Request): Promise<Response> {
		try {
			const metrics = await request.json() as UsageMetrics;
			const updates = new Map<string, number | string>();
			if (!this.initialized) {
				this.initialized = true;
				this.siteId = metrics.siteId;
				this.domain = metrics.domain;
				updates.set(STORAGE_KEYS.SITE_ID, metrics.siteId);
				updates.set(STORAGE_KEYS.DOMAIN, metrics.domain);
			}
			this.bandwidth += metrics.bytes;
			this.requests += 1;
			if (metrics.cacheHit) {
				this.cacheHits += 1;
			} else {
				this.cacheMisses += 1;
			}
			updates.set(STORAGE_KEYS.BANDWIDTH, this.bandwidth);
			updates.set(STORAGE_KEYS.REQUESTS, this.requests);
			updates.set(STORAGE_KEYS.CACHE_HITS, this.cacheHits);
			updates.set(STORAGE_KEYS.CACHE_MISSES, this.cacheMisses);
			await this.state.storage.put(Object.fromEntries(updates));
			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Usage tracker fetch error:", err);
			return new Response("Error", { status: 500 });
		}
	}

	/**
	 * Alarm handler - flushes accumulated metrics to D1 every 60 seconds
	 *
	 * Cloudflare guarantees alarm will fire even if DO instance moves/restarts
	 *
	 * CONCURRENCY NOTE: D1 calls are external I/O (not storage), so fetch() handlers
	 * can interleave during the await. We capture values before the D1 call and
	 * subtract only what we flushed, preserving any metrics added during the write.
	 */
	async alarm(): Promise<void> {
		if (!this.env.BILLING_DB) {
			console.error("[UsageTracker] BILLING_DB not bound - clearing storage and stopping. This is a misconfiguration.");
			this.bandwidth = 0;
			this.requests = 0;
			this.cacheHits = 0;
			this.cacheMisses = 0;
			await this.state.storage.deleteAll();
			await this.state.storage.deleteAlarm();
			return;
		}
		const now = Math.floor(Date.now() / 1000);
		if (this.requests === 0) {
			try {
				await this.state.storage.setAlarm(Date.now() + 60000);
			} catch (alarmErr) {
				console.error("[UsageTracker] Failed to reschedule idle alarm:", alarmErr);
			}
			return;
		}
		const hourStart = Math.floor(Date.now() / 3600000) * 3600;
		const flushBandwidth = this.bandwidth;
		const flushRequests = this.requests;
		const flushCacheHits = this.cacheHits;
		const flushCacheMisses = this.cacheMisses;
		const flushSiteId = this.siteId;
		const flushDomain = this.domain;
		let d1Succeeded = false;
		try {
			const batch = [
				// Update current period totals in sites table
				this.env.BILLING_DB.prepare(
					`UPDATE sites SET
						bandwidth_used_bytes = bandwidth_used_bytes + ?,
						cache_hits = cache_hits + ?,
						cache_misses = cache_misses + ?,
						updated_at = ?
					WHERE id = ?`
				).bind(flushBandwidth, flushCacheHits, flushCacheMisses, now, flushSiteId),
				// Insert/update hourly rollup
				this.env.BILLING_DB.prepare(
					`INSERT INTO usage_hourly (site_id, hour_start, bandwidth_bytes, requests, cache_hits, cache_misses, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (site_id, hour_start) DO UPDATE SET
						bandwidth_bytes = bandwidth_bytes + excluded.bandwidth_bytes,
						requests = requests + excluded.requests,
						cache_hits = cache_hits + excluded.cache_hits,
						cache_misses = cache_misses + excluded.cache_misses,
						updated_at = excluded.updated_at`
				).bind(flushSiteId, hourStart, flushBandwidth, flushRequests, flushCacheHits, flushCacheMisses, now, now)
			];
			await this.env.BILLING_DB.batch(batch);
			d1Succeeded = true;
			console.log(
				`[UsageTracker] Flushed ${flushDomain}: ${flushRequests} req, ${flushBandwidth} bytes, ${flushCacheHits} hits, ${flushCacheMisses} misses`
			);
			this.bandwidth -= flushBandwidth;
			this.requests -= flushRequests;
			this.cacheHits -= flushCacheHits;
			this.cacheMisses -= flushCacheMisses;
			this.d1Failures = 0;
			await this.state.storage.put({
				[STORAGE_KEYS.BANDWIDTH]: this.bandwidth,
				[STORAGE_KEYS.REQUESTS]: this.requests,
				[STORAGE_KEYS.CACHE_HITS]: this.cacheHits,
				[STORAGE_KEYS.CACHE_MISSES]: this.cacheMisses,
				[STORAGE_KEYS.D1_FAILURES]: 0
			});
		} catch (err) {
			if (d1Succeeded) {
				console.error(
					`[UsageTracker] CRITICAL: D1 succeeded but storage failed for ${flushDomain}. If DO evicts before storage recovers, data may be double-counted. Flushed: ${flushBandwidth} bytes, ${flushRequests} requests.`,
					err
				);
			} else {
				try {
					this.d1Failures += 1;
					await this.state.storage.put(STORAGE_KEYS.D1_FAILURES, this.d1Failures);
					console.error(`[UsageTracker] D1 write failed for ${flushDomain}:`, err, {
						consecutiveFailures: this.d1Failures,
						accumulatedBandwidth: this.bandwidth,
						accumulatedRequests: this.requests
					});
					if (this.d1Failures >= D1_FAILURE_ALERT_THRESHOLD) {
						console.error(
							`[UsageTracker] ALERT: ${this.d1Failures} consecutive D1 failures for site:${flushSiteId} (${flushDomain}). Accumulated: ${this.bandwidth} bytes, ${this.requests} requests. Data preserved in DO storage, will retry on next alarm.`
						);
					}
				} catch (storageErr) {
					console.error(`[UsageTracker] Storage error while tracking D1 failure for ${flushDomain}:`, storageErr);
				}
			}
		} finally {
			try {
				await this.state.storage.setAlarm(Date.now() + 60000);
			} catch (alarmErr) {
				console.error(`[UsageTracker] CRITICAL: Failed to reschedule alarm for ${flushDomain}:`, alarmErr);
			}
		}
	}
}

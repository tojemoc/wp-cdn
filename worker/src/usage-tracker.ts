import type { Env } from "./env";

const STORAGE_KEYS = {
	SITE_ID: "siteId",
	DOMAIN: "domain",
	BANDWIDTH: "bandwidth",
	REQUESTS: "requests",
	CACHE_HITS: "cacheHits",
	CACHE_MISSES: "cacheMisses",
	D1_FAILURES: "d1Failures",
	PENDING_FLUSH: "pendingFlush"
};

const D1_FAILURE_ALERT_THRESHOLD = 5;

// What one flush wrote to D1. Stored before the write so a crash mid-flush can
// be settled without double-counting: the flush_id row is written inside the
// same D1 transaction as the counters, so it exists iff the whole batch applied.
interface PendingFlush {
	id: string;
	siteId: number;
	domain: string;
	hourStart: number;
	bandwidth: number;
	requests: number;
	cacheHits: number;
	cacheMisses: number;
}

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
			// Arm only when there is (or might be) usage waiting to flush.
			if (!existingAlarm && this.env.BILLING_DB && this.requests > 0) {
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
			if (this.env.BILLING_DB && !(await this.state.storage.getAlarm())) {
				await this.state.storage.setAlarm(Date.now() + 60000);
			}
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
		const db = this.env.BILLING_DB;

		// Replay a stored flush instead of recomputing from counters: if the last
		// attempt died after the D1 write but before the checkpoint, recomputing
		// would double-count. The flush_id row lives in the same transaction as
		// the deltas, so it exists iff the batch applied.
		let pending = (await this.state.storage.get(STORAGE_KEYS.PENDING_FLUSH)) as PendingFlush | undefined;
		if (!pending) {
			if (this.requests === 0) {
				return; // nothing pending, no alarm needed
			}
			pending = {
				id: crypto.randomUUID(),
				siteId: this.siteId,
				domain: this.domain,
				hourStart: Math.floor(Date.now() / 3600000) * 3600,
				bandwidth: this.bandwidth,
				requests: this.requests,
				cacheHits: this.cacheHits,
				cacheMisses: this.cacheMisses
			};
			await this.state.storage.put(STORAGE_KEYS.PENDING_FLUSH, pending);
		}
		const now = Math.floor(Date.now() / 1000);
		try {
			await db.prepare(
				"CREATE TABLE IF NOT EXISTS usage_flushes (flush_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
			).run();
			try {
				await db.batch([
					// Claim the flush id; a conflict aborts the whole batch.
					db.prepare(
						"INSERT INTO usage_flushes (flush_id, applied_at) VALUES (?, ?)"
					).bind(pending.id, now),
					// Update current period totals in sites table
					db.prepare(
						`UPDATE sites SET
							bandwidth_used_bytes = bandwidth_used_bytes + ?,
							cache_hits = cache_hits + ?,
							cache_misses = cache_misses + ?,
							updated_at = ?
						WHERE id = ?`
					).bind(pending.bandwidth, pending.cacheHits, pending.cacheMisses, now, pending.siteId),
					// Insert/update hourly rollup
					db.prepare(
						`INSERT INTO usage_hourly (site_id, hour_start, bandwidth_bytes, requests, cache_hits, cache_misses, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (site_id, hour_start) DO UPDATE SET
							bandwidth_bytes = bandwidth_bytes + excluded.bandwidth_bytes,
							requests = requests + excluded.requests,
							cache_hits = cache_hits + excluded.cache_hits,
							cache_misses = cache_misses + excluded.cache_misses,
							updated_at = excluded.updated_at`
					).bind(pending.siteId, pending.hourStart, pending.bandwidth, pending.requests, pending.cacheHits, pending.cacheMisses, now, now)
				]);
				console.log(
					`[UsageTracker] Flushed ${pending.domain}: ${pending.requests} req, ${pending.bandwidth} bytes, ${pending.cacheHits} hits, ${pending.cacheMisses} misses`
				);
			} catch (batchErr) {
				// Duplicate flush_id means an earlier attempt committed the batch
				// but crashed before the checkpoint — settle without reapplying.
				const seen = await db.prepare(
					"SELECT flush_id FROM usage_flushes WHERE flush_id = ?"
				).bind(pending.id).first();
				if (!seen) throw batchErr;
				console.log(`[UsageTracker] Flush ${pending.id} already applied; settling checkpoint for ${pending.domain}`);
			}
			this.bandwidth -= pending.bandwidth;
			this.requests -= pending.requests;
			this.cacheHits -= pending.cacheHits;
			this.cacheMisses -= pending.cacheMisses;
			this.d1Failures = 0;
			await this.state.storage.put({
				[STORAGE_KEYS.BANDWIDTH]: this.bandwidth,
				[STORAGE_KEYS.REQUESTS]: this.requests,
				[STORAGE_KEYS.CACHE_HITS]: this.cacheHits,
				[STORAGE_KEYS.CACHE_MISSES]: this.cacheMisses,
				[STORAGE_KEYS.D1_FAILURES]: 0
			});
			await this.state.storage.delete(STORAGE_KEYS.PENDING_FLUSH);
		} catch (err) {
			try {
				this.d1Failures += 1;
				await this.state.storage.put(STORAGE_KEYS.D1_FAILURES, this.d1Failures);
				console.error(`[UsageTracker] D1 write failed for ${pending.domain}:`, err, {
					consecutiveFailures: this.d1Failures,
					accumulatedBandwidth: this.bandwidth,
					accumulatedRequests: this.requests
				});
				if (this.d1Failures >= D1_FAILURE_ALERT_THRESHOLD) {
					console.error(
						`[UsageTracker] ALERT: ${this.d1Failures} consecutive D1 failures for site:${pending.siteId} (${pending.domain}). Accumulated: ${this.bandwidth} bytes, ${this.requests} requests. Data preserved in DO storage, will retry on next alarm.`
					);
				}
			} catch (storageErr) {
				console.error(`[UsageTracker] Storage error while tracking D1 failure for ${pending.domain}:`, storageErr);
			}
		} finally {
			// Keep retrying while usage remains; stop scheduling once counters are empty.
			if (this.requests > 0) {
				try {
					await this.state.storage.setAlarm(Date.now() + 60000);
				} catch (alarmErr) {
					console.error(`[UsageTracker] CRITICAL: Failed to reschedule alarm for ${pending.domain}:`, alarmErr);
				}
			}
		}
	}
}

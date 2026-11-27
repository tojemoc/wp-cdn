import type { DomainRecord, Env } from "./env";

export async function trackUsage(
	env: Env,
	ctx: ExecutionContext,
	domain: string,
	bytes: number,
	cacheHit: boolean,
	domainRecords?: DomainRecord[]
): Promise<void> {
	if (!env.USAGE_TRACKER || !env.BILLING_DB) {
		return;
	}
	if (!domainRecords || domainRecords.length === 0) {
		return;
	}
	for (const record of domainRecords) {
		if (record.status !== "active") continue;
		const doId = env.USAGE_TRACKER.idFromName(`site:${record.site_id}`);
		const stub = env.USAGE_TRACKER.get(doId);
		const metricsRequest = new Request("https://usage-tracker/track", {
			method: "POST",
			body: JSON.stringify({
				siteId: record.site_id,
				domain,
				bytes,
				cacheHit
			})
		});
		ctx.waitUntil(stub.fetch(metricsRequest));
	}
}

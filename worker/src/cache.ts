import type { Env } from "./env";
import type { RangeInfo } from "./range";
import { getCORSHeaders } from "./utils";

export async function getFromCache(env: Env, cacheKey: string): Promise<R2ObjectBody | null> {
	return await env.R2.get(cacheKey);
}

export async function getCacheHead(env: Env, cacheKey: string): Promise<R2Object | null> {
	return await env.R2.head(cacheKey);
}

// RFC 9110 If-None-Match: supports "*", comma-separated tag lists and weak tags.
export function etagMatches(ifNoneMatch: string | null, httpEtag: string): boolean {
	if (!ifNoneMatch) {
		return false;
	}
	if (ifNoneMatch.trim() === "*") {
		return true;
	}
	const bare = httpEtag.replace(/^W\//i, "").replace(/^"|"$/g, "");
	return ifNoneMatch.split(",").some((tag) => tag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "") === bare);
}

export function handleConditionalRequest(request: Request, httpEtag: string): Response | null {
	const ifNoneMatch = request.headers.get("If-None-Match");
	if (etagMatches(ifNoneMatch, httpEtag)) {
		return new Response(null, {
			status: 304,
			headers: {
				"ETag": httpEtag,
				"Cache-Control": "public, max-age=31536000, immutable",
				...getCORSHeaders()
			}
		});
	}
	return null;
}

export async function getFromCacheWithRange(env: Env, cacheKey: string, range?: RangeInfo, etag?: string): Promise<R2ObjectBody | null> {
	if (range) {
		return await env.R2.get(cacheKey, {
			range: {
				offset: range.start,
				length: range.length
			},
			...etag ? { onlyIf: { etagMatches: etag } } : {}
		});
	}
	return await env.R2.get(cacheKey);
}

// Delete only if the object is still the one we inspected. A tiny race remains
// between the head and the delete; the worst case is dropping a freshly replaced
// object, which self-heals on the next origin fetch.
export async function deleteIfUnchanged(env: Env, cacheKey: string, etag: string): Promise<void> {
	const fresh = await getCacheHead(env, cacheKey);
	if (fresh && fresh.etag === etag) {
		await env.R2.delete(cacheKey);
	}
}

export async function storeInCacheStream(
	env: Env,
	cacheKey: string,
	body: ReadableStream,
	contentType: string,
	contentLength: number | null,
	sourceUrl: string,
	domain: string
): Promise<void> {
	if (contentLength === null) {
		console.log(`[R2 CACHE] Skipping cache for chunked response: ${cacheKey}`);
		await body.cancel();
		return;
	}
	const cachedAt = new Date().toISOString();
	const { readable, writable } = new FixedLengthStream(contentLength);
	body.pipeTo(writable).catch(() => {
	});
	const uploadBody = readable;
	await env.R2.put(cacheKey, uploadBody, {
		httpMetadata: {
			contentType,
			cacheControl: "public, max-age=31536000, immutable"
		},
		customMetadata: {
			sourceUrl,
			domain,
			cachedAt,
			...contentLength !== null ? { contentLength: contentLength.toString() } : {}
		}
	});
}

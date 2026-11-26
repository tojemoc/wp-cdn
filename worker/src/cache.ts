import type { Env } from "./env";
import type { RangeInfo } from "./range";
import { getCORSHeaders } from "./utils";

export async function getFromCache(env: Env, cacheKey: string): Promise<R2ObjectBody | null> {
	return await env.R2.get(cacheKey);
}

export async function getCacheHead(env: Env, cacheKey: string): Promise<R2Object | null> {
	return await env.R2.head(cacheKey);
}

export function handleConditionalRequest(request: Request, etag: string): Response | null {
	const ifNoneMatch = request.headers.get("If-None-Match");
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				"ETag": etag,
				"Cache-Control": "public, max-age=31536000, immutable",
				...getCORSHeaders()
			}
		});
	}
	return null;
}

export async function getFromCacheWithRange(env: Env, cacheKey: string, range?: RangeInfo): Promise<R2ObjectBody | null> {
	if (range) {
		return await env.R2.get(cacheKey, {
			range: {
				offset: range.start,
				length: range.length
			}
		});
	}
	return await env.R2.get(cacheKey);
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

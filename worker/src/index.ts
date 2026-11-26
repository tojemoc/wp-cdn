import type { Env, LogEntry } from "./env";
import { parseUrl, validateOrigin, validateUrlForFetch, isMediaContentType, isImageContentType } from "./validation";
import { fetchMediaFromOrigin, validateResponseSize, createSizeLimitedStream } from "./origin";
import { VERSION, getCORSHeaders, errorResponse, formatBytes, parseFileSize } from "./utils";
import { getFromCache, getCacheHead, handleConditionalRequest, getFromCacheWithRange, storeInCacheStream } from "./cache";
import { parseRangeHeader, buildContentRangeHeader } from "./range";
import { createHtmlViewer } from "./viewer";
import { createStatsResponse, createLogger } from "./analytics";
import { trackUsage } from "./usage";
import { SiteUsageTracker } from "./usage-tracker";

export { SiteUsageTracker };

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: getCORSHeaders()
			});
		}

		if (url.pathname === "/health" || url.pathname === "/ping") {
			return new Response(JSON.stringify({
				status: "healthy",
				version: VERSION,
				timestamp: new Date().toISOString()
			}), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					...getCORSHeaders()
				}
			});
		}

		if (url.pathname === "/stats") {
			return createStatsResponse(env);
		}

		try {
			const parsed = parseUrl(url);
			const logs: LogEntry[] = [];
			const startTime = Date.now();
			const addLog = createLogger(logs, startTime, env.DEBUG === "true");
			addLog("Request received", `${request.method} ${parsed.domain}${parsed.path}`);

			if (request.method === "DELETE") {
				return errorResponse("DELETE method not currently supported", 405);
			}

			if (request.method !== "GET" && request.method !== "HEAD") {
				return errorResponse("Method not allowed", 405);
			}

			const isHeadRequest = request.method === "HEAD";
			const rangeHeader = request.headers.get("Range");

			let standardRangeStart: number | null = null;
			let standardRangeEnd: number | null = null;
			if (rangeHeader && rangeHeader.startsWith("bytes=")) {
				const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
				if (match) {
					standardRangeStart = parseInt(match[1], 10);
					standardRangeEnd = parseInt(match[2], 10);
				}
			}
			const isStandardRange = standardRangeStart !== null && standardRangeEnd !== null && standardRangeStart <= standardRangeEnd;
			const isFullFileRange = rangeHeader === "bytes=0-";

			const [validation, cacheResult, rangeData] = await Promise.all([
				validateOrigin(parsed.domain, env),
				parsed.forceReprocess ? Promise.resolve(null) : isHeadRequest || rangeHeader && !isFullFileRange ? getCacheHead(env, parsed.cacheKey) : getFromCache(env, parsed.cacheKey),
				// Full GET request or bytes=0-: get full object
				// For standard ranges (GET only), also fetch the range data in parallel
				// Skip for HEAD requests - they don't need the actual range data
				parsed.forceReprocess || isHeadRequest || !isStandardRange ? Promise.resolve(null) : getFromCacheWithRange(env, parsed.cacheKey, {
					start: standardRangeStart!,
					end: standardRangeEnd!,
					length: standardRangeEnd! - standardRangeStart! + 1,
					isPartial: true
				})
			]);

			addLog("Origin validation", `${validation.reason} (source: ${validation.source})`);

			if (!validation.allowed) {
				addLog("Redirecting to origin", `Reason: ${validation.reason}`);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						// Note: X-ImgPro-Reason removed to prevent information disclosure
						...getCORSHeaders()
					}
				});
			}

			if (isHeadRequest) {
				addLog("HEAD request", "Checking cache metadata");
				if (parsed.forceReprocess) {
					addLog("HEAD + forceReprocess", "Redirecting to origin");
					return new Response(null, {
						status: 302,
						headers: {
							"Location": parsed.sourceUrl,
							"Cache-Control": "no-store, no-cache, must-revalidate",
							"X-ImgPro-Status": "redirect",
							...getCORSHeaders()
						}
					});
				}
				const headResult = cacheResult || await getCacheHead(env, parsed.cacheKey);
				if (headResult) {
					const cachedContentType = (headResult.httpMetadata?.contentType || "").toLowerCase();
					if (!isMediaContentType(cachedContentType)) {
						ctx.waitUntil(env.R2.delete(parsed.cacheKey).catch(() => {
						}));
						return new Response(null, {
							status: 302,
							headers: {
								"Location": parsed.sourceUrl,
								"Cache-Control": "no-store, no-cache, must-revalidate",
								"X-ImgPro-Status": "redirect",
								...getCORSHeaders()
							}
						});
					}
					addLog("HEAD cache hit", `${headResult.size} bytes`);
					return new Response(null, {
						status: 200,
						headers: {
							"Content-Type": headResult.httpMetadata?.contentType || "application/octet-stream",
							"Content-Length": headResult.size.toString(),
							"Accept-Ranges": "bytes",
							"ETag": headResult.etag,
							"Last-Modified": headResult.uploaded.toUTCString(),
							"Cache-Control": "public, max-age=31536000, immutable",
							"X-ImgPro-Status": "hit",
							"X-ImgPro-Cached-At": headResult.customMetadata?.cachedAt || "",
							...getCORSHeaders()
						}
					});
				}
				addLog("HEAD cache miss", "Redirecting to origin");
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						...getCORSHeaders()
					}
				});
			}

			if (cacheResult) {
				addLog("Cache HIT", parsed.cacheKey);
				const cachedContentType = (cacheResult.httpMetadata?.contentType || "").toLowerCase();
				if (!isMediaContentType(cachedContentType)) {
					addLog("Invalid cached content", `${cachedContentType} - deleting and redirecting`);
					ctx.waitUntil(env.R2.delete(parsed.cacheKey).catch((e) => {
						console.error("Failed to delete invalid cache entry:", e);
					}));
					return new Response(null, {
						status: 302,
						headers: {
							"Location": parsed.sourceUrl,
							"Cache-Control": "no-store, no-cache, must-revalidate",
							"X-ImgPro-Status": "redirect",
							"X-ImgPro-Reason": "invalid_cached_content",
							...getCORSHeaders()
						}
					});
				}

				const conditionalResponse = handleConditionalRequest(request, cacheResult.etag);
				if (conditionalResponse) {
					addLog("Conditional request", "304 Not Modified");
					trackUsage(env, ctx, parsed.domain, 0, true, validation.domain_records);
					return conditionalResponse;
				}

				const contentType = cacheResult.httpMetadata?.contentType || "application/octet-stream";
				const metadata = cacheResult.customMetadata || {};
				const totalSize = cacheResult.size;
				const rangeInfo = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

				if (rangeHeader && !rangeInfo) {
					addLog("Invalid range", `${rangeHeader} for size ${totalSize}`);
					return new Response("Range Not Satisfiable", {
						status: 416,
						headers: {
							"Content-Range": `bytes */${totalSize}`,
							"Accept-Ranges": "bytes",
							...getCORSHeaders()
						}
					});
				}

				if (parsed.viewImage && env.DEBUG === "true" && isImageContentType(contentType)) {
					const fullObjectForView = rangeHeader ? await getFromCache(env, parsed.cacheKey) : cacheResult;
					if (fullObjectForView && "body" in fullObjectForView) {
						const imageData = await (fullObjectForView as R2ObjectBody).arrayBuffer();
						const totalTime = Date.now() - startTime;
						addLog("Generating HTML viewer", `${imageData.byteLength} bytes in ${totalTime}ms`);
						return createHtmlViewer({
							imageData,
							contentType,
							status: "cached",
							imageSize: imageData.byteLength,
							sourceUrl: parsed.sourceUrl,
							cdnUrl: request.url.split("?")[0],
							cacheKey: parsed.cacheKey,
							cachedAt: metadata.cachedAt,
							processingTime: totalTime,
							logs,
							env
						});
					}
				}

				if (rangeInfo?.isPartial) {
					addLog("Range request", `bytes ${rangeInfo.start}-${rangeInfo.end}/${totalSize}`);
					const partialObject = isStandardRange && rangeData ? rangeData : await getFromCacheWithRange(env, parsed.cacheKey, rangeInfo);
					if (!partialObject) {
						return new Response(null, {
							status: 302,
							headers: {
								"Location": parsed.sourceUrl,
								"Cache-Control": "no-store, no-cache, must-revalidate",
								...getCORSHeaders()
							}
						});
					}
					addLog("Serving partial", `${rangeInfo.length} bytes${isStandardRange ? " (parallel fetch)" : ""}`);
					trackUsage(env, ctx, parsed.domain, rangeInfo.length, true, validation.domain_records);
					return new Response(partialObject.body, {
						status: 206,
						headers: {
							"Content-Type": contentType,
							"Content-Length": rangeInfo.length.toString(),
							"Content-Range": buildContentRangeHeader(rangeInfo.start, rangeInfo.end, totalSize),
							"Accept-Ranges": "bytes",
							"Cache-Control": "public, max-age=31536000, immutable",
							"ETag": cacheResult.etag,
							"Last-Modified": cacheResult.uploaded.toUTCString(),
							"X-ImgPro-Status": "hit",
							"X-ImgPro-Cached-At": metadata.cachedAt || "",
							...getCORSHeaders()
						}
					});
				}

				let fullObject: R2ObjectBody | null = null;
				if ("body" in cacheResult) {
					fullObject = cacheResult as R2ObjectBody;
				} else if (isStandardRange && rangeData) {
					fullObject = rangeData;
				} else if (rangeHeader) {
					fullObject = await getFromCache(env, parsed.cacheKey);
				}
				if (!fullObject) {
					return new Response(null, {
						status: 302,
						headers: {
							"Location": parsed.sourceUrl,
							"Cache-Control": "no-store, no-cache, must-revalidate",
							...getCORSHeaders()
						}
					});
				}

				const bytesToTrack = rangeInfo ? rangeInfo.length : fullObject.size;
				trackUsage(env, ctx, parsed.domain, bytesToTrack, true, validation.domain_records);
				addLog("Serving media", `${fullObject.size} bytes, ${contentType}`);
				const cachedHeaders: Record<string, string> = {
					"Content-Type": contentType,
					"Content-Length": fullObject.size.toString(),
					"Accept-Ranges": "bytes",
					"Cache-Control": "public, max-age=31536000, immutable",
					"ETag": cacheResult.etag,
					"Last-Modified": cacheResult.uploaded.toUTCString(),
					"X-ImgPro-Status": "hit",
					"X-ImgPro-Cached-At": metadata.cachedAt || "",
					...getCORSHeaders()
				};
				if (rangeInfo) {
					cachedHeaders["Content-Range"] = buildContentRangeHeader(rangeInfo.start, rangeInfo.end, totalSize);
				}
				return new Response(fullObject.body, {
					status: rangeInfo ? 206 : 200,
					headers: cachedHeaders
				});
			}

			if (parsed.forceReprocess) {
				addLog("Cache bypass", "Force reprocess requested");
			}
			addLog("Cache MISS", `Fetching from origin: ${parsed.sourceUrl}`);

			if (rangeHeader && !isFullFileRange) {
				addLog("Partial range on cache miss", `${rangeHeader} - redirecting to origin`);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						"X-ImgPro-Redirect-Reason": "partial-range-cache-miss",
						...getCORSHeaders()
					}
				});
			}

			const validateRedirect = async (finalUrl: string): Promise<boolean> => {
				const urlValidation = validateUrlForFetch(finalUrl);
				if (!urlValidation.valid || !urlValidation.domain) {
					return false;
				}
				const redirectValidation = await validateOrigin(urlValidation.domain, env);
				return redirectValidation.allowed;
			};

			const fetchResult = await fetchMediaFromOrigin(parsed.sourceUrl, env, request, undefined, validateRedirect);
			const response = fetchResult.response;

			if (fetchResult.blocked) {
				addLog("Origin blocked", `${fetchResult.blockReason} - redirecting to origin`);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						"X-ImgPro-Block-Reason": fetchResult.blockReason || "unknown",
						...getCORSHeaders()
					}
				});
			}

			if (!response.ok) {
				addLog("Origin fetch failed", `HTTP ${response.status} - redirecting to origin`);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						...getCORSHeaders()
					}
				});
			}
			addLog("Origin fetch success", `HTTP ${response.status}`);

			const contentType = response.headers.get("Content-Type") || "";
			if (!isMediaContentType(contentType)) {
				addLog("Not supported media", `${contentType} - redirecting to origin`);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						...getCORSHeaders()
					}
				});
			}
			addLog("Content type validated", contentType);

			const maxSize = parseFileSize(env.MAX_FILE_SIZE || "500MB");
			const sizeValidation = validateResponseSize(response, maxSize);
			if (!sizeValidation.valid) {
				addLog("File too large", `${sizeValidation.reason} - redirecting to origin`);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						...getCORSHeaders()
					}
				});
			}
			const contentLength = sizeValidation.size;
			addLog("Size validated", contentLength ? `${formatBytes(contentLength)}` : "unknown (chunked)");

			if (!response.body) {
				addLog("No response body", "redirecting to origin");
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						...getCORSHeaders()
					}
				});
			}

			const { stream: limitedStream, byteCount } = createSizeLimitedStream(response.body, maxSize);
			const [cacheStream, responseStream] = limitedStream.tee();

			ctx.waitUntil(
				byteCount.then((bytes) => {
					trackUsage(env, ctx, parsed.domain, bytes, false, validation.domain_records);
				}).catch(() => {
				})
			);

			ctx.waitUntil(
				storeInCacheStream(
					env,
					parsed.cacheKey,
					cacheStream,
					contentType,
					contentLength,
					parsed.sourceUrl,
					parsed.domain
				).catch((e) => {
					console.error("Failed to store in cache:", e);
				})
			);
			addLog("Storing in R2", "streaming (background)");
			addLog("Serving media", `streaming, ${contentType}`);

			const shouldReturn206 = rangeHeader && contentLength !== null && contentLength > 0;
			const status = shouldReturn206 ? 206 : 200;
			const responseHeaders: Record<string, string> = {
				"Content-Type": contentType,
				"Accept-Ranges": "bytes",
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-ImgPro-Status": "miss",
				...getCORSHeaders()
			};
			if (contentLength !== null) {
				responseHeaders["Content-Length"] = contentLength.toString();
			}
			if (shouldReturn206 && contentLength !== null) {
				responseHeaders["Content-Range"] = `bytes 0-${contentLength - 1}/${contentLength}`;
			}

			let finalResponseStream: ReadableStream = responseStream;
			if (contentLength !== null) {
				const { readable, writable } = new FixedLengthStream(contentLength);
				responseStream.pipeTo(writable).catch(() => {
				});
				finalResponseStream = readable;
			}

			return new Response(finalResponseStream, {
				status,
				headers: responseHeaders
			});
		} catch (error) {
			console.error("Worker error:", error);
			try {
				const parsed = parseUrl(url);
				return new Response(null, {
					status: 302,
					headers: {
						"Location": parsed.sourceUrl,
						"Cache-Control": "no-store, no-cache, must-revalidate",
						"X-ImgPro-Status": "redirect",
						...getCORSHeaders()
					}
				});
			} catch {
				return errorResponse("Invalid request", 400);
			}
		}
	}
};

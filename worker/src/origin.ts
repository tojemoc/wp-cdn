import type { Env } from "./env";
import { validateUrlForFetch } from "./validation";

const FALLBACK_HEADERS: Record<string, string> = {
	"User-Agent": "ImgPro/1.0 (+https://img.pro/cdn)",
	"Accept": "image/*, video/*, audio/*, application/vnd.apple.mpegurl"
};

const FORWARDED_HEADERS = [
	"User-Agent",
	"Accept",
	"Accept-Language",
	"Referer"
	// Where the image is embedded (anti-hotlinking bypass)
];

function getForwardedHeaders(clientRequest?: Request): Record<string, string> {
	if (!clientRequest) {
		return {};
	}
	const forwarded: Record<string, string> = {};
	for (const header of FORWARDED_HEADERS) {
		const value = clientRequest.headers.get(header);
		if (value) {
			forwarded[header] = value;
		}
	}
	return forwarded;
}

export interface BlockCheck {
	blocked: boolean;
	reason?: string;
}

export function detectBlockedResponse(response: Response, expectedCategory = "media"): BlockCheck {
	const contentType = (response.headers.get("content-type") || "").toLowerCase();
	const contentLength = response.headers.get("content-length");
	if (response.status === 403 || response.status === 401) {
		return { blocked: true, reason: `http_${response.status}` };
	}
	if (response.status === 429) {
		return { blocked: true, reason: "rate_limited" };
	}
	if (contentType.includes("text/html")) {
		if (contentLength && parseInt(contentLength, 10) < 50000) {
			return { blocked: true, reason: "html_challenge_page" };
		}
		return { blocked: true, reason: "html_instead_of_media" };
	}
	if (contentType.startsWith("text/")) {
		return { blocked: true, reason: "text_instead_of_media" };
	}
	if (contentType.includes("application/json")) {
		return { blocked: true, reason: "json_instead_of_media" };
	}
	if (expectedCategory === "image") {
		if (contentType && !contentType.startsWith("image/")) {
			return { blocked: true, reason: "non_image_content_type" };
		}
	} else if (expectedCategory === "video") {
		if (contentType && !contentType.startsWith("video/")) {
			return { blocked: true, reason: "non_video_content_type" };
		}
	} else if (expectedCategory === "audio") {
		if (contentType && !contentType.startsWith("audio/")) {
			return { blocked: true, reason: "non_audio_content_type" };
		}
	}
	return { blocked: false };
}

export async function fetchFromOrigin(
	url: string,
	env: Env,
	clientRequest?: Request,
	timeout?: number,
	validateRedirect?: (url: string) => Promise<boolean>
): Promise<Response> {
	const urlValidation = validateUrlForFetch(url);
	if (!urlValidation.valid) {
		throw new Error(`Invalid URL: ${urlValidation.reason}`);
	}
	const fetchTimeout = timeout || parseInt(env.FETCH_TIMEOUT || "30000", 10);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);
	const forwardedHeaders = getForwardedHeaders(clientRequest);
	const headers: Record<string, string> = {
		...FALLBACK_HEADERS,
		...forwardedHeaders
	};
	if (env.ORIGIN_USER_AGENT) {
		headers["User-Agent"] = env.ORIGIN_USER_AGENT;
	}
	if (env.FORWARD_CLIENT_IP === "true" && clientRequest) {
		const clientIp = clientRequest.headers.get("cf-connecting-ip");
		if (clientIp) {
			headers["X-Forwarded-For"] = clientIp;
		}
	}
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers,
			redirect: "follow"
		});
		const finalUrl = response.url;
		if (finalUrl && finalUrl !== url) {
			const validation = validateUrlForFetch(finalUrl);
			if (!validation.valid) {
				throw new Error(`Redirect to invalid URL blocked: ${validation.reason}`);
			}
			if (validateRedirect) {
				const allowed = await validateRedirect(finalUrl);
				if (!allowed) {
					throw new Error(`Redirect to non-allowed origin blocked: ${finalUrl}`);
				}
			}
		}
		return response;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request timeout after ${fetchTimeout}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

export interface MediaFetchResult {
	response: Response;
	blocked: boolean;
	blockReason?: string;
}

export async function fetchMediaFromOrigin(
	url: string,
	env: Env,
	clientRequest?: Request,
	timeout?: number,
	validateRedirect?: (url: string) => Promise<boolean>
): Promise<MediaFetchResult> {
	const response = await fetchFromOrigin(url, env, clientRequest, timeout, validateRedirect);
	const blockCheck = detectBlockedResponse(response, "media");
	return {
		response,
		blocked: blockCheck.blocked,
		blockReason: blockCheck.reason
	};
}

export interface SizeValidation {
	valid: boolean;
	size: number | null;
	reason?: string;
}

export function validateResponseSize(response: Response, maxSize: number): SizeValidation {
	const contentLength = response.headers.get("content-length");
	if (!contentLength) {
		return { valid: true, size: null };
	}
	const size = parseInt(contentLength, 10);
	if (isNaN(size)) {
		return { valid: true, size: null };
	}
	if (size > maxSize) {
		return {
			valid: false,
			size,
			reason: `File too large: ${size} bytes (max ${maxSize} bytes)`
		};
	}
	return { valid: true, size };
}

export function createSizeLimitedStream(stream: ReadableStream, maxSize: number): {
	stream: ReadableStream;
	byteCount: Promise<number>;
} {
	let totalBytes = 0;
	let resolveByteCount!: (bytes: number) => void;
	let rejectByteCount!: (error: Error) => void;
	const byteCountPromise = new Promise<number>((resolve, reject) => {
		resolveByteCount = resolve;
		rejectByteCount = reject;
	});
	const transformStream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			totalBytes += chunk.byteLength;
			if (totalBytes > maxSize) {
				const error = new Error(`Stream exceeded max size: ${totalBytes} bytes (max ${maxSize} bytes)`);
				rejectByteCount(error);
				controller.error(error);
				return;
			}
			controller.enqueue(chunk);
		},
		flush() {
			resolveByteCount(totalBytes);
		},
		cancel(reason) {
			rejectByteCount(new Error(`Stream cancelled: ${reason || "unknown"}`));
		}
	});
	return {
		stream: stream.pipeThrough(transformStream),
		byteCount: byteCountPromise
	};
}

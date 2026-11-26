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

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

// The deadline must cover the body download, not just the headers: pipe the
// body through a pass-through stream that clears the timer only on completion
// or cancel, so a stalled origin still aborts mid-transfer.
function keepDeadlineUntilBodyDone(response: Response, timeoutId: ReturnType<typeof setTimeout>): Response {
	if (!response.body) {
		clearTimeout(timeoutId);
		return response;
	}
	const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		flush() {
			clearTimeout(timeoutId);
		},
		cancel() {
			clearTimeout(timeoutId);
		}
	}));
	return new Response(body, response);
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
	// Ask for an unencoded body so Content-Length matches the bytes we stream.
	const baseHeaders: Record<string, string> = {
		...FALLBACK_HEADERS,
		"Accept-Encoding": "identity"
	};
	let headers: Record<string, string> = {
		...baseHeaders,
		...getForwardedHeaders(clientRequest)
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
	let currentUrl = url;
	try {
		for (let hop = 0; ; hop++) {
			const response = await fetch(currentUrl, {
				signal: controller.signal,
				headers,
				redirect: "manual"
			});
			if (!REDIRECT_STATUSES.includes(response.status)) {
				return keepDeadlineUntilBodyDone(response, timeoutId);
			}
			const location = response.headers.get("location");
			if (!location) {
				return keepDeadlineUntilBodyDone(response, timeoutId);
			}
			if (hop >= MAX_REDIRECTS) {
				throw new Error("Too many redirects");
			}
			const nextUrl = new URL(location, currentUrl).toString();
			const validation = validateUrlForFetch(nextUrl);
			if (!validation.valid) {
				throw new Error(`Redirect to invalid URL blocked: ${validation.reason}`);
			}
			if (validateRedirect && !(await validateRedirect(nextUrl))) {
				throw new Error(`Redirect to non-allowed origin blocked: ${nextUrl}`);
			}
			// Never leak client-identifying headers to a different origin.
			if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
				headers = { ...baseHeaders };
				if (env.ORIGIN_USER_AGENT) {
					headers["User-Agent"] = env.ORIGIN_USER_AGENT;
				}
			}
			currentUrl = nextUrl;
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request timeout after ${fetchTimeout}ms`);
		}
		throw error;
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
	// An encoded body (rare: we request identity, but not every origin obeys) makes
	// Content-Length describe bytes we are not streaming — treat it as unknown.
	const encoding = response.headers.get("content-encoding");
	if (encoding && encoding.toLowerCase() !== "identity") {
		return { valid: true, size: null };
	}
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

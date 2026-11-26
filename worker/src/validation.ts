import type { DomainRecord, Env } from "./env";

export interface ParsedUrl {
	domain: string;
	path: string;
	sourceUrl: string;
	cacheKey: string;
	forceReprocess: boolean;
	viewImage: boolean;
}

export interface OriginValidation {
	allowed: boolean;
	reason: string;
	source: string;
	domain_records?: DomainRecord[];
}

export interface UrlValidation {
	valid: boolean;
	domain: string | null;
	reason?: string;
}

export function normalizePath(path: string): string {
	const segments = path.split("/").filter((s) => s !== "");
	const normalized: string[] = [];
	for (const segment of segments) {
		if (segment === "..") {
			normalized.pop();
		} else if (segment !== ".") {
			normalized.push(segment);
		}
	}
	return "/" + normalized.join("/");
}

export function parseUrl(url: URL): ParsedUrl {
	const decodedPathname = decodeURIComponent(url.pathname);
	const pathParts = decodedPathname.replace(/^\/+/, "").split("/");
	if (pathParts.length < 2) {
		throw new Error("Invalid URL format: /domain.com/path/to/image.jpg");
	}
	const domain = pathParts[0].toLowerCase();
	const rawPath = "/" + pathParts.slice(1).join("/");
	const path = normalizePath(rawPath);
	if (path === "/" || path === "") {
		throw new Error("Invalid path: path traversal detected");
	}
	if (!isValidDomain(domain)) {
		throw new Error(`Invalid domain: ${domain}`);
	}
	const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
	const sourceUrl = `https://${domain}${encodedPath}`;
	const cacheKey = `${domain}${path}`;
	const forceReprocess = url.searchParams.get("force") === "true" || url.searchParams.get("force") === "1";
	const viewImage = url.searchParams.get("view") === "true" || url.searchParams.get("view") === "1";
	return { domain, path, sourceUrl, cacheKey, forceReprocess, viewImage };
}

export function isValidDomain(domain: string): boolean {
	if (!domain || !domain.trim()) {
		return false;
	}
	const lowerDomain = domain.toLowerCase();
	const blockedHostnames = [
		"localhost",
		"localhost.localdomain",
		"broadcasthost"
	];
	if (blockedHostnames.includes(lowerDomain)) {
		return false;
	}
	const ipv4Match = domain.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4Match) {
		return false;
	}
	if (domain.includes(":") || /^\[.*\]$/.test(domain)) {
		return false;
	}
	const internalPatterns = [
		/\.local$/i,
		/\.localhost$/i,
		/\.internal$/i,
		/\.lan$/i,
		/\.home$/i,
		/\.corp$/i,
		/\.private$/i,
		// Cloud provider metadata services
		/^metadata\.google\.internal$/i,
		/\.compute\.internal$/i,
		/\.ec2\.internal$/i,
		/^instance-data\./i,
		// Common metadata hostnames
		/^metadata\./i,
		/^169\.254\./
		// Link-local / metadata IP range as domain
	];
	if (internalPatterns.some((pattern) => pattern.test(lowerDomain))) {
		return false;
	}
	const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
	return domainRegex.test(domain);
}

export function matchesDomainPattern(domain: string, pattern: string): boolean {
	const lowerDomain = domain.toLowerCase();
	const lowerPattern = pattern.toLowerCase().trim();
	if (!lowerPattern) {
		return false;
	}
	if (lowerPattern.startsWith("*.")) {
		const baseDomain = lowerPattern.substring(2);
		return lowerDomain.endsWith("." + baseDomain);
	}
	return lowerDomain === lowerPattern;
}

export function matchesDomainList(domain: string, list: string): boolean {
	if (!list || list.trim() === "") {
		return false;
	}
	const patterns = list.split(",").map((p) => p.trim()).filter((p) => p !== "");
	return patterns.some((pattern) => matchesDomainPattern(domain, pattern));
}

async function getDomainRecords(domain: string, kv: KVNamespace): Promise<DomainRecord[]> {
	try {
		const value = await kv.get(domain, { cacheTtl: 60 });
		if (!value) return [];
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		console.error("KV domain lookup failed:", error);
		return [];
	}
}

export async function validateOrigin(domain: string, env: Env): Promise<OriginValidation> {
	const mode = env.ORIGIN_MODE || "open";
	const configBlocked = env.BLOCKED_ORIGINS || "";
	if (configBlocked === "*") {
		return { allowed: false, reason: "blocked", source: "config" };
	}
	if (configBlocked && matchesDomainList(domain, configBlocked)) {
		return { allowed: false, reason: "blocked", source: "config" };
	}
	if (mode === "open") {
		return { allowed: true, reason: "allowed", source: "default" };
	}
	if (mode === "list") {
		const configAllowed = env.ALLOWED_ORIGINS || "";
		if (!configAllowed) {
			return { allowed: false, reason: "not_in_allowlist", source: "config" };
		}
		if (matchesDomainList(domain, configAllowed)) {
			let domain_records: DomainRecord[] | undefined;
			if (env.ORIGINS_KV) {
				try {
					domain_records = await getDomainRecords(domain, env.ORIGINS_KV);
				} catch (e) {
					console.warn("[validateOrigin] KV lookup failed in list mode:", e);
				}
			}
			return { allowed: true, reason: "allowed", source: "config", domain_records };
		}
		return { allowed: false, reason: "not_in_allowlist", source: "config" };
	}
	if (mode === "registered") {
		if (!env.ORIGINS_KV) {
			console.error('ORIGIN_MODE is "registered" but ORIGINS_KV is not bound');
			return { allowed: false, reason: "not_in_allowlist", source: "kv" };
		}
		const records = await getDomainRecords(domain, env.ORIGINS_KV);
		if (records.length === 0) {
			return { allowed: false, reason: "not_in_allowlist", source: "kv" };
		}
		const hasActive = records.some((r) => r.status === "active");
		if (hasActive) {
			return { allowed: true, reason: "allowed", source: "kv", domain_records: records };
		}
		return { allowed: false, reason: "blocked", source: "kv", domain_records: records };
	}
	console.error(`Unknown ORIGIN_MODE: ${mode}`);
	return { allowed: false, reason: "not_in_allowlist", source: "config" };
}

export function validateUrlForFetch(url: string): UrlValidation {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { valid: false, domain: null, reason: "invalid_scheme" };
		}
		if (parsed.username || parsed.password) {
			return { valid: false, domain: null, reason: "credentials_in_url" };
		}
		const port = parsed.port;
		if (port && port !== "80" && port !== "443") {
			return { valid: false, domain: null, reason: "non_standard_port" };
		}
		const domain = parsed.hostname.toLowerCase();
		if (!isValidDomain(domain)) {
			return { valid: false, domain: null, reason: "invalid_domain" };
		}
		return { valid: true, domain };
	} catch {
		return { valid: false, domain: null, reason: "invalid_url" };
	}
}

export function isImageContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const mimeType = contentType.toLowerCase().split(";")[0].trim();
	const imageTypes = [
		"image/jpeg",
		"image/jpg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/avif",
		"image/svg+xml",
		"image/bmp",
		"image/tiff",
		"image/x-icon",
		"image/heic",
		"image/heif",
		"image/jxl"
	];
	return imageTypes.includes(mimeType);
}

export function isVideoContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const mimeType = contentType.toLowerCase().split(";")[0].trim();
	const videoTypes = [
		"video/mp4",
		"video/webm",
		"video/ogg",
		"video/quicktime",
		"video/x-matroska",
		"video/x-m4v",
		"video/mp2t"
		// HLS segments (.ts)
	];
	return videoTypes.includes(mimeType);
}

export function isAudioContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const mimeType = contentType.toLowerCase().split(";")[0].trim();
	const audioTypes = [
		"audio/mpeg",
		"audio/ogg",
		"audio/wav",
		"audio/webm",
		"audio/x-m4a",
		"audio/mp4",
		"audio/aac",
		"audio/flac"
	];
	return audioTypes.includes(mimeType);
}

export function isHLSContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const mimeType = contentType.toLowerCase().split(";")[0].trim();
	const hlsTypes = [
		"application/vnd.apple.mpegurl",
		"application/x-mpegurl",
		"audio/mpegurl",
		"audio/x-mpegurl"
	];
	return hlsTypes.includes(mimeType);
}

export function isMediaContentType(contentType: string | null): boolean {
	return isImageContentType(contentType) || isVideoContentType(contentType) || isAudioContentType(contentType) || isHLSContentType(contentType);
}

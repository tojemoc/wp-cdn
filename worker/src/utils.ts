export const VERSION = "1.3.0";

export function getCORSHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, HEAD, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400"
	};
}

export function errorResponse(message: string, status: number): Response {
	return new Response(JSON.stringify({
		error: message,
		status
	}), {
		status,
		headers: {
			"Content-Type": "application/json",
			...getCORSHeaders()
		}
	});
}

export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatTime(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	} else if (ms < 60000) {
		return `${(ms / 1000).toFixed(2)}s`;
	} else {
		const minutes = Math.floor(ms / 60000);
		const seconds = (ms % 60000 / 1000).toFixed(0);
		return `${minutes}m ${seconds}s`;
	}
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function parseFileSize(sizeStr: string): number {
	const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
	if (!match) {
		throw new Error(`Invalid file size format: ${sizeStr}`);
	}
	const value = parseFloat(match[1]);
	const unit = (match[2] || "B").toUpperCase();
	const multipliers: Record<string, number> = {
		"B": 1,
		"KB": 1024,
		"MB": 1024 * 1024,
		"GB": 1024 * 1024 * 1024,
		"TB": 1024 * 1024 * 1024 * 1024
	};
	return Math.floor(value * multipliers[unit]);
}

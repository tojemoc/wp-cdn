export interface Env {
	R2: R2Bucket;
	ORIGINS_KV?: KVNamespace;
	USAGE_TRACKER?: DurableObjectNamespace;
	BILLING_DB?: D1Database;

	ORIGIN_MODE?: string; // "open" | "list" | "registered"
	ALLOWED_ORIGINS?: string;
	BLOCKED_ORIGINS?: string;
	ORIGIN_USER_AGENT?: string;
	FORWARD_CLIENT_IP?: string;
	FETCH_TIMEOUT?: string;
	MAX_FILE_SIZE?: string;
	DEBUG?: string;
}

export interface DomainRecord {
	site_id: number;
	domain?: string;
	status: string;
}

export interface LogEntry {
	time: string;
	action: string;
	details?: string;
}

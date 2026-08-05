const DEFAULT_TIMEOUT_MS = 10_000;

export interface HttpResponseLike {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}

export type FetchLike = (
	url: string,
	init: {
		readonly headers: Readonly<Record<string, string>>;
		readonly redirect: "error";
		readonly signal: AbortSignal;
	},
) => Promise<HttpResponseLike>;

export interface FetchJsonOptions {
	readonly headers: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetch?: FetchLike;
}

export class HttpTimeoutError extends Error {
	constructor() {
		super("Request timed out");
		this.name = "HttpTimeoutError";
	}
}

export class HttpNetworkError extends Error {
	constructor() {
		super("Network request failed");
		this.name = "HttpNetworkError";
	}
}

export class HttpStatusError extends Error {
	readonly status: number;
	readonly retryAfterSeconds: number | undefined;

	constructor(status: number, retryAfterSeconds: number | undefined) {
		super(`Request failed with status ${status}`);
		this.name = "HttpStatusError";
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds);
	}
	const dateMs = Date.parse(value);
	if (Number.isNaN(dateMs)) return undefined;
	return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
	const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	let response: HttpResponseLike;
	try {
		response = await fetchImpl(url, { headers: options.headers, redirect: "error", signal });
	} catch (error) {
		if (timeoutSignal.aborted) {
			throw new HttpTimeoutError();
		}
		if (signal.aborted) {
			throw error;
		}
		throw new HttpNetworkError();
	}

	if (!response.ok) {
		throw new HttpStatusError(
			response.status,
			parseRetryAfterSeconds(response.headers.get("retry-after")),
		);
	}

	return response.json();
}

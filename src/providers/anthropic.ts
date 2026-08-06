import type { QuotaModelRegistry } from "../auth.ts";
import { resolveOAuthCredentials } from "../auth.ts";
import type { FetchLike } from "../http.ts";
import { fetchJson, HttpNetworkError, HttpStatusError, HttpTimeoutError } from "../http.ts";
import type { ProviderResult, QuotaWindow } from "../types.ts";
import { clampPercent } from "../types.ts";

const PROVIDER_ID = "anthropic" as const;
const DISPLAY_NAME = "Anthropic";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

export interface AnthropicQuotaOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetch?: FetchLike;
}

interface RawWindow {
	readonly utilization?: unknown;
	readonly resets_at?: unknown;
	readonly resetsAt?: unknown;
	readonly reset_at?: unknown;
	readonly resetAt?: unknown;
}

interface RawUsage {
	readonly five_hour?: unknown;
	readonly fiveHour?: unknown;
	readonly seven_day?: unknown;
	readonly sevenDay?: unknown;
}

function asRecord<T extends object>(value: unknown): T | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as T)
		: undefined;
}

function parseResetAt(window: RawWindow): Date | undefined {
	const raw = window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt;
	if (typeof raw !== "string") return undefined;
	const parsed = Date.parse(raw.trim());
	if (Number.isNaN(parsed)) return undefined;
	return new Date(parsed);
}

function parseWindow(label: string, value: unknown): QuotaWindow | undefined {
	const window = asRecord<RawWindow>(value);
	if (!window) return undefined;
	const utilization = window.utilization;
	if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
	const remainingPercent = clampPercent(100 - utilization);
	const resetAt = parseResetAt(window);
	return resetAt ? { label, remainingPercent, resetAt } : { label, remainingPercent };
}

function parseUsage(payload: unknown): ProviderResult {
	const root = asRecord<RawUsage>(payload);
	if (!root) {
		return { kind: "failure", provider: PROVIDER_ID, reason: { type: "invalid-response" } };
	}
	const fiveHour = parseWindow("Five-hour", root.five_hour ?? root.fiveHour);
	const sevenDay = parseWindow("Weekly", root.seven_day ?? root.sevenDay);
	if (!fiveHour || !sevenDay) {
		return { kind: "unavailable", provider: PROVIDER_ID, reason: "no-quota-windows" };
	}
	return {
		kind: "success",
		provider: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		windows: [fiveHour, sevenDay],
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function toFailure(error: unknown): ProviderResult {
	if (error instanceof HttpTimeoutError) {
		return { kind: "failure", provider: PROVIDER_ID, reason: { type: "timeout" } };
	}
	if (error instanceof HttpNetworkError) {
		return { kind: "failure", provider: PROVIDER_ID, reason: { type: "network-error" } };
	}
	if (error instanceof HttpStatusError) {
		const reason = { type: "http-error", status: error.status } as const;
		return error.retryAfterSeconds === undefined
			? { kind: "failure", provider: PROVIDER_ID, reason }
			: {
					kind: "failure",
					provider: PROVIDER_ID,
					reason,
					retryAfterSeconds: error.retryAfterSeconds,
				};
	}
	return { kind: "failure", provider: PROVIDER_ID, reason: { type: "invalid-response" } };
}

export async function fetchAnthropicQuota(
	registry: QuotaModelRegistry,
	options: AnthropicQuotaOptions = {},
): Promise<ProviderResult> {
	const auth = await resolveOAuthCredentials(registry, PROVIDER_ID);
	if (!auth.ok) {
		return { kind: "unavailable", provider: PROVIDER_ID, reason: auth.reason };
	}

	let payload: unknown;
	try {
		payload = await fetchJson(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${auth.credentials.accessToken}`,
				"anthropic-beta": BETA_HEADER,
			},
			...(options.signal ? { signal: options.signal } : {}),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return toFailure(error);
	}

	return parseUsage(payload);
}

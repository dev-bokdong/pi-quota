import type { FetchLike } from "../http.ts";
import { fetchJson, HttpNetworkError, HttpStatusError, HttpTimeoutError } from "../http.ts";
import type { AccountFields, ProviderId, ProviderResult, QuotaWindow } from "../types.ts";
import { clampPercent } from "../types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

/**
 * Anthropic's subscription usage endpoint, read on behalf of one provider lane.
 * Both the `anthropic` OAuth login and a Claude SDK OAuth account are Claude
 * subscription credentials answered by this one endpoint, so the lane only
 * decides which token is sent and how the result is labelled.
 */
export interface AnthropicUsageRequest {
	readonly provider: ProviderId;
	readonly displayName: string;
	readonly accessToken: string;
	readonly account: AccountFields;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetch?: FetchLike;
}

/** The result fields every outcome of one lookup carries. */
type Lane = Pick<AnthropicUsageRequest, "provider" | "displayName" | "account">;

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

function parseUsage(payload: unknown, lane: Lane): ProviderResult {
	const root = asRecord<RawUsage>(payload);
	if (!root) {
		return {
			kind: "failure",
			provider: lane.provider,
			reason: { type: "invalid-response" },
			...lane.account,
		};
	}
	const fiveHour = parseWindow("Five-hour", root.five_hour ?? root.fiveHour);
	const sevenDay = parseWindow("Weekly", root.seven_day ?? root.sevenDay);
	if (!fiveHour || !sevenDay) {
		return {
			kind: "unavailable",
			provider: lane.provider,
			reason: "no-quota-windows",
			...lane.account,
		};
	}
	return {
		kind: "success",
		provider: lane.provider,
		displayName: lane.displayName,
		windows: [fiveHour, sevenDay],
		...lane.account,
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function toFailure(error: unknown, lane: Lane): ProviderResult {
	const account = lane.account;
	if (error instanceof HttpTimeoutError) {
		return { kind: "failure", provider: lane.provider, reason: { type: "timeout" }, ...account };
	}
	if (error instanceof HttpNetworkError) {
		return {
			kind: "failure",
			provider: lane.provider,
			reason: { type: "network-error" },
			...account,
		};
	}
	if (error instanceof HttpStatusError) {
		const reason = { type: "http-error", status: error.status } as const;
		return error.retryAfterSeconds === undefined
			? { kind: "failure", provider: lane.provider, reason, ...account }
			: {
					kind: "failure",
					provider: lane.provider,
					reason,
					retryAfterSeconds: error.retryAfterSeconds,
					...account,
				};
	}
	return {
		kind: "failure",
		provider: lane.provider,
		reason: { type: "invalid-response" },
		...account,
	};
}

/**
 * Reads one Claude subscription credential's usage. Never throws except to
 * propagate the caller's own cancellation; every other outcome is a
 * ProviderResult carrying the calling lane's identity.
 */
export async function fetchAnthropicUsage(request: AnthropicUsageRequest): Promise<ProviderResult> {
	const lane: Lane = {
		provider: request.provider,
		displayName: request.displayName,
		account: request.account,
	};

	let payload: unknown;
	try {
		payload = await fetchJson(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${request.accessToken}`,
				"anthropic-beta": BETA_HEADER,
			},
			...(request.signal ? { signal: request.signal } : {}),
			...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
			...(request.fetch ? { fetch: request.fetch } : {}),
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return toFailure(error, lane);
	}

	return parseUsage(payload, lane);
}

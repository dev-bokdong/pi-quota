import { type QuotaModelRegistry, resolveOAuthCredentials } from "../auth.ts";
import type { FetchLike } from "../http.ts";
import { fetchJson, HttpNetworkError, HttpStatusError, HttpTimeoutError } from "../http.ts";
import type { ProviderFailureReason, ProviderResult, QuotaWindow } from "../types.ts";
import { clampPercent } from "../types.ts";

const PROVIDER_ID = "openai-codex" as const;
const DISPLAY_NAME = "OpenAI";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type WindowKind = "Five-hour" | "Weekly" | "Monthly";

const WINDOW_KIND_BY_DURATION: Readonly<Record<number, WindowKind>> = {
	18000: "Five-hour",
	604800: "Weekly",
	2628000: "Monthly",
};

const WINDOW_ORDER: readonly WindowKind[] = ["Five-hour", "Weekly", "Monthly"];
const CODE_REVIEW_LABEL = "Code Review";

export interface OpenAiQuotaOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetch?: FetchLike;
}

interface WindowValue {
	readonly remainingPercent: number;
	readonly resetAt: Date | undefined;
}

function property(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dateFromMilliseconds(milliseconds: number): Date | undefined {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function resetAtFrom(window: unknown): Date | undefined {
	const absoluteSeconds = finiteNumber(property(window, "reset_at"));
	if (absoluteSeconds !== undefined && absoluteSeconds > 0) {
		const absolute = dateFromMilliseconds(Math.round(absoluteSeconds * 1000));
		if (absolute) return absolute;
	}
	const relativeSeconds = finiteNumber(property(window, "reset_after_seconds"));
	if (relativeSeconds === undefined || relativeSeconds <= 0) return undefined;
	return dateFromMilliseconds(Date.now() + Math.round(relativeSeconds * 1000));
}

/** Parses a window that reports how much of the quota has been consumed. */
function parseUsedWindow(window: unknown): WindowValue | undefined {
	const usedPercent = finiteNumber(property(window, "used_percent"));
	if (usedPercent === undefined) return undefined;
	return { remainingPercent: clampPercent(100 - usedPercent), resetAt: resetAtFrom(window) };
}

/** Parses a window that already reports the remaining quota. */
function parseRemainingWindow(window: unknown): WindowValue | undefined {
	const remainingPercent = finiteNumber(property(window, "remaining_percent"));
	if (remainingPercent === undefined) return undefined;
	return { remainingPercent: clampPercent(remainingPercent), resetAt: resetAtFrom(window) };
}

/** Parses a rate limit window, classifying it by its declared duration. */
function parseRateLimitWindow(
	window: unknown,
): { readonly kind: WindowKind; readonly value: WindowValue } | undefined {
	const durationSeconds = finiteNumber(property(window, "limit_window_seconds"));
	if (durationSeconds === undefined) return undefined;
	const kind = WINDOW_KIND_BY_DURATION[durationSeconds];
	if (!kind) return undefined;
	const value = parseUsedWindow(window);
	return value ? { kind, value } : undefined;
}

function sameWindow(left: WindowValue, right: WindowValue): boolean {
	return (
		left.remainingPercent === right.remainingPercent &&
		left.resetAt?.getTime() === right.resetAt?.getTime()
	);
}

function toQuotaWindow(label: string, value: WindowValue): QuotaWindow {
	return value.resetAt
		? { label, remainingPercent: value.remainingPercent, resetAt: value.resetAt }
		: { label, remainingPercent: value.remainingPercent };
}

function collectWindows(usage: unknown): readonly QuotaWindow[] {
	const rateLimit = property(usage, "rate_limit");
	const byKind = new Map<WindowKind, WindowValue>();
	const conflicting = new Set<WindowKind>();

	for (const raw of [
		property(rateLimit, "primary_window"),
		property(rateLimit, "secondary_window"),
	]) {
		const parsed = parseRateLimitWindow(raw);
		if (!parsed || conflicting.has(parsed.kind)) continue;
		const existing = byKind.get(parsed.kind);
		if (!existing) {
			byKind.set(parsed.kind, parsed.value);
		} else if (!sameWindow(existing, parsed.value)) {
			// Two windows disagree about the same period: neither can be trusted.
			byKind.delete(parsed.kind);
			conflicting.add(parsed.kind);
		}
	}

	if (!byKind.has("Monthly") && !conflicting.has("Monthly")) {
		const individualLimit = parseRemainingWindow(
			property(property(usage, "spend_control"), "individual_limit"),
		);
		if (individualLimit) byKind.set("Monthly", individualLimit);
	}

	const windows: QuotaWindow[] = [];
	for (const kind of WINDOW_ORDER) {
		const value = byKind.get(kind);
		if (value) windows.push(toQuotaWindow(kind, value));
	}

	// Always the code review window regardless of the duration it reports.
	const codeReview = parseUsedWindow(
		property(property(usage, "code_review_rate_limit"), "primary_window"),
	);
	if (codeReview) windows.push(toQuotaWindow(CODE_REVIEW_LABEL, codeReview));

	return windows;
}

/**
 * Reads the ChatGPT account id from the access token when the host runtime
 * provides the helper. A missing account id is not an error: the usage
 * endpoint answers without the account header too.
 */
async function resolveAccountId(accessToken: string): Promise<string | undefined> {
	try {
		const module: unknown = await import("@earendil-works/pi-ai");
		const extract = property(module, "extractOpenAiCodexAccountId");
		if (typeof extract !== "function") return undefined;
		const accountId: unknown = (extract as (token: string) => unknown)(accessToken);
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function failure(reason: ProviderFailureReason, retryAfterSeconds?: number): ProviderResult {
	return retryAfterSeconds === undefined
		? { kind: "failure", provider: PROVIDER_ID, reason }
		: { kind: "failure", provider: PROVIDER_ID, reason, retryAfterSeconds };
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Reads the OpenAI Codex subscription quota. Never throws except to propagate
 * the caller's own cancellation; every other outcome is a ProviderResult.
 */
export async function fetchOpenAiQuota(
	registry: QuotaModelRegistry,
	options: OpenAiQuotaOptions = {},
): Promise<ProviderResult> {
	const auth = await resolveOAuthCredentials(registry, PROVIDER_ID);
	if (!auth.ok) {
		return { kind: "unavailable", provider: PROVIDER_ID, reason: auth.reason };
	}

	const accessToken = auth.credentials.accessToken;
	const accountId = await resolveAccountId(accessToken);
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	let usage: unknown;
	try {
		usage = await fetchJson(USAGE_URL, {
			headers,
			...(options.signal ? { signal: options.signal } : {}),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	} catch (error) {
		if (error instanceof HttpTimeoutError) return failure({ type: "timeout" });
		if (error instanceof HttpNetworkError) return failure({ type: "network-error" });
		if (error instanceof HttpStatusError) {
			return failure({ type: "http-error", status: error.status }, error.retryAfterSeconds);
		}
		if (isAbortError(error)) throw error;
		return failure({ type: "invalid-response" });
	}

	if (typeof usage !== "object" || usage === null) {
		return failure({ type: "invalid-response" });
	}

	const windows = collectWindows(usage);
	if (windows.length === 0) {
		return { kind: "unavailable", provider: PROVIDER_ID, reason: "no-quota-windows" };
	}

	return { kind: "success", provider: PROVIDER_ID, displayName: DISPLAY_NAME, windows };
}

import type {
	ProviderFailure,
	ProviderId,
	ProviderResult,
	ProviderSuccess,
	ProviderUnavailable,
	QuotaWindow,
	UnavailableReason,
} from "./types.ts";
import { clampPercent } from "./types.ts";

/** Provider names as the quota block shows them. */
const DISPLAY_NAMES: Readonly<Record<ProviderId, string>> = {
	"openai-codex": "OpenAI",
	anthropic: "Anthropic",
	"claude-sdk-oauth": "Claude SDK",
};

/**
 * The host dims info notifications with its own theme color, so the quota
 * block carries an explicit bright-white foreground run per line. Line-level
 * runs survive the host re-styling or re-wrapping individual lines, and the
 * foreground-only reset leaves the host's other attributes untouched.
 */
const WHITE = "\u001b[97m";
const FOREGROUND_RESET = "\u001b[39m";

const HEADER_INDENT = " ".repeat(3);
const ROW_INDENT = " ".repeat(5);
const BAR_WIDTH = 25;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
/** Reset times are right-aligned to the bar's right edge. */
const ROW_WIDTH = ROW_INDENT.length + BAR_WIDTH;

/**
 * The account label appears only for a provider that pools more than one
 * account, which is exactly when the adapter sets it: single-account output
 * stays the bare provider name.
 */
function bracketed(name: string, account?: string): string {
	return account === undefined ? `[${name}]` : `[${name}: ${account}]`;
}

function displayNameForProvider(result: ProviderUnavailable | ProviderFailure): string {
	return bracketed(DISPLAY_NAMES[result.provider], result.account);
}

/**
 * Renders the remaining time at one granularity: whole days from 24h up,
 * half-hours below 24h, whole minutes below 1h. Every step rounds down so the
 * displayed time never overstates what is left.
 */
function formatResetTime(resetAt: Date, now: Date): string {
	const differenceMilliseconds = resetAt.getTime() - now.getTime();
	if (differenceMilliseconds <= 0) return "now";

	const totalMinutes = Math.floor(differenceMilliseconds / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;

	const days = Math.floor(totalMinutes / (24 * 60));
	if (days > 0) return `${days}d`;

	const halfHours = Math.floor(totalMinutes / 30) / 2;
	return `${halfHours}h`;
}

function progressBar(percent: number): string {
	const filled = Math.round((percent * BAR_WIDTH) / 100);
	return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_WIDTH - filled)}`;
}

function formatWindow(window: QuotaWindow, now: Date): readonly string[] {
	const percent = clampPercent(window.remainingPercent);
	const head = `${ROW_INDENT}${window.label}`;
	const resetText = window.resetAt ? formatResetTime(window.resetAt, now) : "";
	const gap = " ".repeat(Math.max(1, ROW_WIDTH - head.length - resetText.length));

	return [
		resetText === "" ? head : `${head}${gap}${resetText}`,
		`${ROW_INDENT}${progressBar(percent)} ${percent}%`,
	];
}

/**
 * Explanations for the unavailable outcomes the quota block reports. A reason
 * missing from this record is one that only means the provider holds no OAuth
 * to read, which `isReported` keeps out of the block entirely.
 */
const UNAVAILABLE_MESSAGES = {
	"token-expired": "the stored token has expired - sign in again to refresh it",
	"no-quota-windows": "no quota data in the response",
} as const satisfies Partial<Record<UnavailableReason, string>>;

type ReportedUnavailable = ProviderUnavailable & {
	readonly reason: keyof typeof UNAVAILABLE_MESSAGES;
};

type ReportedResult = ProviderSuccess | ReportedUnavailable | ProviderFailure;

/**
 * A provider whose credentials hold no OAuth - never signed in, or signed in
 * with an API key - is left out of the answer rather than reported: the session
 * never asked about that provider, so naming it would only add a warning about
 * something that is not wrong.
 */
function isReported(result: ProviderResult): result is ReportedResult {
	return result.kind !== "unavailable" || Object.hasOwn(UNAVAILABLE_MESSAGES, result.reason);
}

function formatUnavailable(result: ReportedUnavailable): string {
	const message = UNAVAILABLE_MESSAGES[result.reason];

	return `${HEADER_INDENT}${displayNameForProvider(result)}: ${message}`;
}

function formatFailure(result: ProviderFailure): string {
	let message: string;

	switch (result.reason.type) {
		case "http-error":
			message = `request failed (HTTP ${result.reason.status})`;
			break;
		case "network-error":
			message = "network error";
			break;
		case "timeout":
			message = "request timed out";
			break;
		case "invalid-response":
			message = "response could not be parsed";
			break;
	}

	const retryMessage =
		result.retryAfterSeconds === undefined ? "" : ` · retry in ${result.retryAfterSeconds}s`;
	return `${HEADER_INDENT}${displayNameForProvider(result)}: ${message}${retryMessage}`;
}

function formatSuccess(result: ProviderSuccess, now: Date): string {
	const lines = result.windows.flatMap((window) => formatWindow(window, now));

	return [`${HEADER_INDENT}${bracketed(result.displayName, result.account)}`, ...lines].join("\n");
}

/**
 * Renders the quota block, which holds one entry per provider the session could
 * actually read. An empty string means nothing was readable at all and there is
 * therefore nothing to show.
 */
export function formatQuotaResults(
	results: readonly ProviderResult[],
	now: Date = new Date(),
): string {
	return results
		.filter(isReported)
		.map((result) => {
			switch (result.kind) {
				case "success":
					return formatSuccess(result, now);
				case "unavailable":
					return formatUnavailable(result);
				case "failure":
					return formatFailure(result);
				default: {
					const exhaustive: never = result;
					throw new Error(`Unhandled provider result kind: ${JSON.stringify(exhaustive)}`);
				}
			}
		})
		.join("\n\n");
}

export function whiteText(text: string): string {
	return text
		.split("\n")
		.map((line) => (line === "" ? line : `${WHITE}${line}${FOREGROUND_RESET}`))
		.join("\n");
}

/**
 * Severity of the rendered block, judged only by the providers it reports: a
 * provider left out for holding no OAuth cannot turn a complete answer into a
 * warning. Nothing left to report carries no severity of its own - that block
 * is empty and never shown.
 */
export function notifySeverityForResults(
	results: readonly ProviderResult[],
): "error" | "warning" | "info" {
	const reported = results.filter(isReported);
	if (reported.every((result) => result.kind === "success")) return "info";
	if (reported.every((result) => result.kind !== "success")) return "error";
	return "warning";
}

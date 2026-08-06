import type { ProviderFailure, ProviderResult, ProviderUnavailable } from "./types.ts";
import { clampPercent } from "./types.ts";

function displayNameForProvider(provider: ProviderResult["provider"]): string {
	return provider === "openai-codex" ? "OpenAI" : "Anthropic";
}

function formatResetTime(resetAt: Date, now: Date): string {
	const differenceMilliseconds = resetAt.getTime() - now.getTime();
	if (differenceMilliseconds <= 0) return "now";

	const totalMinutes = Math.floor(differenceMilliseconds / 60_000);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	const paddedMinutes = `${minutes.toString().padStart(2, "0")}m`;

	if (days > 0) return `in ${days}d ${hours}h ${paddedMinutes}`;
	return `in ${hours}h ${paddedMinutes}`;
}

function formatUnavailable(result: ProviderUnavailable): string {
	const messages = {
		"oauth-not-configured": "not signed in with OAuth",
		"unsupported-auth-method":
			"this account uses an API key, not OAuth - subscription quota isn't available",
		"no-quota-windows": "no quota data in the response",
	} as const;

	return `${displayNameForProvider(result.provider)}: ${messages[result.reason]}`;
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
	return `${displayNameForProvider(result.provider)}: ${message}${retryMessage}`;
}

function formatSuccess(result: Extract<ProviderResult, { kind: "success" }>, now: Date): string {
	const labelWidth = Math.max(0, ...result.windows.map((window) => window.label.length));
	const lines = result.windows.map((window) => {
		const resetText = window.resetAt ? ` · resets ${formatResetTime(window.resetAt, now)}` : "";
		return `  ${window.label.padEnd(labelWidth)}  ${clampPercent(window.remainingPercent)}% left${resetText}`;
	});

	return [result.displayName, ...lines].join("\n");
}

export function formatQuotaResults(
	results: readonly ProviderResult[],
	now: Date = new Date(),
): string {
	return results
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

export function notifySeverityForResults(
	results: readonly ProviderResult[],
): "error" | "warning" | "info" {
	if (results.every((result) => result.kind !== "success")) return "error";
	if (results.every((result) => result.kind === "success")) return "info";
	return "warning";
}

import { describe, expect, it } from "vitest";
import { formatQuotaResults, notifySeverityForResults } from "../src/format.ts";
import type { ProviderResult } from "../src/types.ts";

const now = new Date(2026, 7, 8, 6, 46);

const openAiSuccess = {
	kind: "success",
	provider: "openai-codex",
	displayName: "OpenAI",
	windows: [
		{
			label: "5h",
			remainingPercent: 82,
			resetAt: new Date(2026, 7, 8, 9),
		},
		{
			label: "Weekly",
			remainingPercent: 61,
			resetAt: new Date(2026, 7, 10, 9),
		},
	],
} as const satisfies ProviderResult;

const anthropicSuccess = {
	kind: "success",
	provider: "anthropic",
	displayName: "Anthropic",
	windows: [
		{
			label: "5h",
			remainingPercent: 74,
			resetAt: new Date(2026, 7, 8, 7, 49),
		},
		{
			label: "Weekly",
			remainingPercent: 48,
			resetAt: new Date(2026, 7, 10, 12),
		},
	],
} as const satisfies ProviderResult;

describe("formatQuotaResults", () => {
	it("formats successful providers as aligned multi-window blocks", () => {
		expect(formatQuotaResults([openAiSuccess, anthropicSuccess], now)).toBe(
			[
				"OpenAI",
				"  5h      82% left · resets in 2h 14m",
				"  Weekly  61% left · resets Aug 10 09:00",
				"",
				"Anthropic",
				"  5h      74% left · resets in 1h 03m",
				"  Weekly  48% left · resets Aug 10 12:00",
			].join("\n"),
		);
	});

	it("omits reset text when a window has no reset time", () => {
		const result = {
			...openAiSuccess,
			windows: [{ label: "Monthly", remainingPercent: 50 }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([result], now)).toBe("OpenAI\n  Monthly  50% left");
	});

	it("uses relative reset times within 24 hours", () => {
		expect(formatQuotaResults([openAiSuccess], now)).toContain("resets in 2h 14m");
	});

	it("uses absolute reset times beyond 24 hours", () => {
		expect(formatQuotaResults([openAiSuccess], now)).toContain("resets Aug 10 09:00");
	});

	it("includes successful output alongside unavailable-provider explanations", () => {
		const unavailable = {
			kind: "unavailable",
			provider: "anthropic",
			reason: "oauth-not-configured",
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([openAiSuccess, unavailable], now)).toBe(
			[
				"OpenAI",
				"  5h      82% left · resets in 2h 14m",
				"  Weekly  61% left · resets Aug 10 09:00",
				"",
				"Anthropic: not signed in with OAuth",
			].join("\n"),
		);
	});

	it("renders HTTP failure statuses without error details", () => {
		const failure = {
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 500 },
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([failure], now)).toBe("OpenAI: request failed (HTTP 500)");
	});

	it("does not throw for a successful result with empty windows", () => {
		const emptySuccess = {
			...openAiSuccess,
			windows: [],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([emptySuccess], now)).toBe("OpenAI");
	});
});

describe("notifySeverityForResults", () => {
	it("returns error when every provider failed", () => {
		const failures = [
			{ kind: "failure", provider: "openai-codex", reason: { type: "timeout" } },
			{ kind: "failure", provider: "anthropic", reason: { type: "network-error" } },
		] as const satisfies readonly ProviderResult[];

		expect(notifySeverityForResults(failures)).toBe("error");
	});

	it("returns warning for mixed success and failure", () => {
		const failure = {
			kind: "failure",
			provider: "anthropic",
			reason: { type: "timeout" },
		} as const satisfies ProviderResult;

		expect(notifySeverityForResults([openAiSuccess, failure])).toBe("warning");
	});

	it("returns info when every provider succeeded", () => {
		expect(notifySeverityForResults([openAiSuccess, anthropicSuccess])).toBe("info");
	});
});

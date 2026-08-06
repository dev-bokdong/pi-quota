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
			label: "Five-hour",
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
			label: "Five-hour",
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
	it("formats successful providers as indented bar blocks", () => {
		expect(formatQuotaResults([openAiSuccess, anthropicSuccess], now)).toBe(
			[
				"   [OpenAI]",
				"     Five-hour              2h",
				"     █████████████████████░░░░ 82%",
				"     Weekly                 2d",
				"     ███████████████░░░░░░░░░░ 61%",
				"",
				"   [Anthropic]",
				"     Five-hour              1h",
				"     ███████████████████░░░░░░ 74%",
				"     Weekly                 2d",
				"     ████████████░░░░░░░░░░░░░ 48%",
			].join("\n"),
		);
	});

	it("right-aligns every reset time to the bar's right edge", () => {
		const lines = formatQuotaResults([openAiSuccess, anthropicSuccess], now)
			.split("\n")
			.filter((line) => line.startsWith("     ") && !line.includes("%"));

		expect(lines).toHaveLength(4);
		for (const line of lines) expect(line).toHaveLength(30);
	});

	it("omits reset text when a window has no reset time", () => {
		const result = {
			...openAiSuccess,
			windows: [{ label: "Monthly", remainingPercent: 50 }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([result], now)).toBe(
			["   [OpenAI]", "     Monthly", "     █████████████░░░░░░░░░░░░ 50%"].join("\n"),
		);
	});

	it("rounds sub-24-hour reset times down to half hours", () => {
		const halfHour = {
			...openAiSuccess,
			windows: [{ label: "Five-hour", remainingPercent: 50, resetAt: new Date(2026, 7, 9, 5, 25) }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([halfHour], now)).toContain("22.5h");
	});

	it("uses whole days for reset times of 24 hours or more", () => {
		expect(formatQuotaResults([openAiSuccess], now)).toContain("2d");
		expect(formatQuotaResults([openAiSuccess], now)).not.toContain("2d ");
	});

	it("uses whole minutes for reset times under one hour", () => {
		const soon = {
			...openAiSuccess,
			windows: [{ label: "Five-hour", remainingPercent: 9, resetAt: new Date(2026, 7, 8, 7, 44) }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([soon], now)).toContain("58m");
	});

	it("reports elapsed reset times as now", () => {
		const elapsed = {
			...openAiSuccess,
			windows: [{ label: "Five-hour", remainingPercent: 5, resetAt: new Date(2026, 7, 8, 6, 45) }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([elapsed], now)).toBe(
			["   [OpenAI]", "     Five-hour             now", "     █░░░░░░░░░░░░░░░░░░░░░░░░ 5%"].join(
				"\n",
			),
		);
	});

	it("includes successful output alongside unavailable-provider explanations", () => {
		const unavailable = {
			kind: "unavailable",
			provider: "anthropic",
			reason: "oauth-not-configured",
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([openAiSuccess, unavailable], now)).toBe(
			[
				"   [OpenAI]",
				"     Five-hour              2h",
				"     █████████████████████░░░░ 82%",
				"     Weekly                 2d",
				"     ███████████████░░░░░░░░░░ 61%",
				"",
				"   [Anthropic]: not signed in with OAuth",
			].join("\n"),
		);
	});

	it("renders HTTP failure statuses without error details", () => {
		const failure = {
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 500 },
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([failure], now)).toBe("   [OpenAI]: request failed (HTTP 500)");
	});

	it("does not throw for a successful result with empty windows", () => {
		const emptySuccess = {
			...openAiSuccess,
			windows: [],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([emptySuccess], now)).toBe("   [OpenAI]");
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

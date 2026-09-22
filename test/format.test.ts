import { describe, expect, it } from "vitest";
import { formatQuotaResults, notifySeverityForResults, whiteText } from "../src/format.ts";
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
			reason: "no-quota-windows",
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([openAiSuccess, unavailable], now)).toBe(
			[
				"   [OpenAI]",
				"     Five-hour              2h",
				"     █████████████████████░░░░ 82%",
				"     Weekly                 2d",
				"     ███████████████░░░░░░░░░░ 61%",
				"",
				"   [Anthropic]: no quota data in the response",
			].join("\n"),
		);
	});

	it("leaves out a provider that holds no OAuth instead of explaining it", () => {
		const notConfigured = {
			kind: "unavailable",
			provider: "anthropic",
			reason: "oauth-not-configured",
		} as const satisfies ProviderResult;
		const apiKeyOnly = {
			kind: "unavailable",
			provider: "claude-sdk-oauth",
			reason: "unsupported-auth-method",
			account: "work",
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([openAiSuccess, notConfigured, apiKeyOnly], now)).toBe(
			[
				"   [OpenAI]",
				"     Five-hour              2h",
				"     █████████████████████░░░░ 82%",
				"     Weekly                 2d",
				"     ███████████████░░░░░░░░░░ 61%",
			].join("\n"),
		);
		expect(formatQuotaResults([notConfigured, apiKeyOnly], now)).toBe("");
	});

	it("renders HTTP failure statuses without error details", () => {
		const failure = {
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 500 },
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([failure], now)).toBe("   [OpenAI]: request failed (HTTP 500)");
	});

	it("labels a provider block with its credential account", () => {
		const labelled = {
			...openAiSuccess,
			account: "work",
			windows: [{ label: "Weekly", remainingPercent: 61, resetAt: new Date(2026, 7, 10, 9) }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([labelled], now)).toBe(
			[
				"   [OpenAI: work]",
				"     Weekly                 2d",
				"     ███████████████░░░░░░░░░░ 61%",
			].join("\n"),
		);
	});

	it("marks a blocked account and leaves every other block unmarked", () => {
		const blocked = {
			...openAiSuccess,
			account: "default",
			blocked: true,
			windows: [{ label: "Five-hour", remainingPercent: 0, resetAt: new Date(2026, 7, 8, 9) }],
		} as const satisfies ProviderResult;
		const usable = { ...openAiSuccess, account: "work", windows: [] } as const;

		expect(formatQuotaResults([blocked, usable], now)).toBe(
			[
				"   [OpenAI: default] - blocked",
				"     Five-hour              2h",
				"     ░░░░░░░░░░░░░░░░░░░░░░░░░ 0%",
				"",
				"   [OpenAI: work]",
			].join("\n"),
		);
	});

	it("renders one labelled block per account of the same provider", () => {
		const first = { ...openAiSuccess, account: "default", windows: [] } as const;
		const second = { ...openAiSuccess, account: "work", windows: [] } as const;

		expect(formatQuotaResults([first, second], now)).toBe(
			["   [OpenAI: default]", "", "   [OpenAI: work]"].join("\n"),
		);
	});

	it("labels unavailable and failed accounts too", () => {
		const unavailable = {
			kind: "unavailable",
			provider: "anthropic",
			reason: "no-quota-windows",
			account: "login-2",
		} as const satisfies ProviderResult;
		const failure = {
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 401 },
			account: "work",
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([unavailable, failure], now)).toBe(
			[
				"   [Anthropic: login-2]: no quota data in the response",
				"",
				"   [OpenAI: work]: request failed (HTTP 401)",
			].join("\n"),
		);
	});

	it("names the Claude SDK OAuth lane in its own block", () => {
		const claudeSuccess = {
			kind: "success",
			provider: "claude-sdk-oauth",
			displayName: "Claude SDK",
			windows: [{ label: "Five-hour", remainingPercent: 74, resetAt: new Date(2026, 7, 8, 7, 49) }],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([anthropicSuccess, claudeSuccess], now)).toBe(
			[
				"   [Anthropic]",
				"     Five-hour              1h",
				"     ███████████████████░░░░░░ 74%",
				"     Weekly                 2d",
				"     ████████████░░░░░░░░░░░░░ 48%",
				"",
				"   [Claude SDK]",
				"     Five-hour              1h",
				"     ███████████████████░░░░░░ 74%",
			].join("\n"),
		);
	});

	it("labels Claude SDK OAuth accounts and explains an expired token", () => {
		const expired = {
			kind: "unavailable",
			provider: "claude-sdk-oauth",
			reason: "token-expired",
			account: "work",
		} as const satisfies ProviderResult;
		const failure = {
			kind: "failure",
			provider: "claude-sdk-oauth",
			reason: { type: "http-error", status: 401 },
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([expired, failure], now)).toBe(
			[
				"   [Claude SDK: work]: the stored token has expired - sign in again to refresh it",
				"",
				"   [Claude SDK]: request failed (HTTP 401)",
			].join("\n"),
		);
	});

	it("does not throw for a successful result with empty windows", () => {
		const emptySuccess = {
			...openAiSuccess,
			windows: [],
		} as const satisfies ProviderResult;

		expect(formatQuotaResults([emptySuccess], now)).toBe("   [OpenAI]");
	});
});

describe("whiteText", () => {
	it("wraps every non-empty line in its own bright-white run", () => {
		expect(whiteText("first\n\nsecond")).toBe(
			"\u001b[97mfirst\u001b[39m\n\n\u001b[97msecond\u001b[39m",
		);
	});

	it("keeps the rendered text intact once the color codes are stripped", () => {
		const rendered = whiteText(formatQuotaResults([openAiSuccess], now));

		expect(rendered.replaceAll("\u001b[97m", "").replaceAll("\u001b[39m", "")).toBe(
			formatQuotaResults([openAiSuccess], now),
		);
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

	it("ignores providers that hold no OAuth", () => {
		const notConfigured = {
			kind: "unavailable",
			provider: "anthropic",
			reason: "oauth-not-configured",
		} as const satisfies ProviderResult;
		const apiKeyOnly = {
			kind: "unavailable",
			provider: "claude-sdk-oauth",
			reason: "unsupported-auth-method",
		} as const satisfies ProviderResult;

		expect(notifySeverityForResults([openAiSuccess, notConfigured, apiKeyOnly])).toBe("info");
		expect(notifySeverityForResults([notConfigured, apiKeyOnly])).toBe("info");
	});
});

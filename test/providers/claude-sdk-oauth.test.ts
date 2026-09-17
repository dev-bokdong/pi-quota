import { describe, expect, it } from "vitest";
import type { EnvReader, QuotaModelRegistry } from "../../src/auth.ts";
import type { FetchLike, HttpResponseLike } from "../../src/http.ts";
import { fetchClaudeSdkOauthQuota } from "../../src/providers/claude-sdk-oauth.ts";

const SLOT_TOKEN = "sk-ant-oat-claude-slot-canary-should-never-leak";
const ENV_TOKEN = "sk-ant-oat-claude-env-canary-should-never-leak";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const HOUR_MS = 60 * 60 * 1000;

interface FetchCall {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly redirect: string;
}

interface StoredSlot {
	readonly name: string;
	readonly displayName?: string;
	readonly access?: string;
	readonly refresh?: string;
	readonly expires?: number;
}

/**
 * Host whose Claude SDK OAuth credential pools the given accounts. Its auth
 * resolution deliberately answers with the managed marker the real host
 * projects, so a provider that read the token through it would send garbage.
 */
function claudeRegistry(slots: readonly StoredSlot[]): QuotaModelRegistry {
	return {
		getAvailable: () => [{ provider: "claude-sdk-oauth" }],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "claude-sdk-oauth-managed" }),
		authStorage: {
			listSlots: (provider: string) => (provider === "claude-sdk-oauth" ? slots : []),
		},
	};
}

function emptyEnv(): EnvReader {
	return () => undefined;
}

function recordingFetch(
	respond: (call: FetchCall) => HttpResponseLike | Promise<HttpResponseLike>,
): { fetch: FetchLike; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetch: FetchLike = async (url, init) => {
		const call = { url, headers: init.headers, redirect: init.redirect };
		calls.push(call);
		return respond(call);
	};
	return { fetch, calls };
}

function jsonResponse(body: unknown): HttpResponseLike {
	return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

function errorResponse(status: number, retryAfter?: string): HttpResponseLike {
	return {
		ok: false,
		status,
		headers: {
			get: (name: string) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
		},
		json: async () => {
			throw new Error("body must never be read");
		},
	};
}

function usageResponse(): HttpResponseLike {
	return jsonResponse({
		five_hour: { utilization: 26, resets_at: "2026-09-17T12:00:00Z" },
		seven_day: { utilization: 52, resets_at: "2026-09-21T12:00:00Z" },
	});
}

describe("fetchClaudeSdkOauthQuota", () => {
	it("reads the only account's stored token and reports both windows", async () => {
		const { fetch, calls } = recordingFetch(() => usageResponse());
		const registry = claudeRegistry([
			{ name: "default", access: SLOT_TOKEN, expires: Date.now() + HOUR_MS },
		]);

		const result = await fetchClaudeSdkOauthQuota(registry, { fetch, env: emptyEnv() });

		expect(result).toEqual({
			kind: "success",
			provider: "claude-sdk-oauth",
			displayName: "Claude SDK",
			windows: [
				{
					label: "Five-hour",
					remainingPercent: 74,
					resetAt: new Date("2026-09-17T12:00:00Z"),
				},
				{
					label: "Weekly",
					remainingPercent: 48,
					resetAt: new Date("2026-09-21T12:00:00Z"),
				},
			],
		});
		expect(calls).toEqual([
			{
				url: USAGE_URL,
				headers: {
					Authorization: `Bearer ${SLOT_TOKEN}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
				redirect: "error",
			},
		]);
	});

	it("authenticates with the named account's own token and labels the result", async () => {
		const { fetch, calls } = recordingFetch(() => usageResponse());
		const registry = claudeRegistry([
			{ name: "default", access: `${SLOT_TOKEN}-default`, expires: Date.now() + HOUR_MS },
			{
				name: "login-2",
				displayName: "work",
				access: `${SLOT_TOKEN}-login-2`,
				expires: Date.now() + HOUR_MS,
			},
		]);

		const result = await fetchClaudeSdkOauthQuota(registry, {
			fetch,
			env: emptyEnv(),
			account: { name: "login-2", label: "work" },
		});

		expect(result).toMatchObject({
			kind: "success",
			provider: "claude-sdk-oauth",
			account: "work",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers["Authorization"]).toBe(`Bearer ${SLOT_TOKEN}-login-2`);
	});

	it("reads an environment-provided account", async () => {
		const { fetch, calls } = recordingFetch(() => usageResponse());
		const env: EnvReader = (name) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? ENV_TOKEN : undefined);

		const result = await fetchClaudeSdkOauthQuota(claudeRegistry([]), { fetch, env });

		expect(result).toMatchObject({ kind: "success", provider: "claude-sdk-oauth" });
		expect(calls[0]?.headers["Authorization"]).toBe(`Bearer ${ENV_TOKEN}`);
	});

	it("reports an expired stored token without sending a request", async () => {
		const { fetch, calls } = recordingFetch(() => usageResponse());
		const registry = claudeRegistry([
			{ name: "default", access: SLOT_TOKEN, expires: Date.now() - HOUR_MS },
		]);

		const result = await fetchClaudeSdkOauthQuota(registry, { fetch, env: emptyEnv() });

		expect(result).toEqual({
			kind: "unavailable",
			provider: "claude-sdk-oauth",
			reason: "token-expired",
		});
		expect(calls).toHaveLength(0);
	});

	it("reports unavailable and sends nothing when the lane has no account", async () => {
		const { fetch, calls } = recordingFetch(() => usageResponse());

		const result = await fetchClaudeSdkOauthQuota(claudeRegistry([]), {
			fetch,
			env: emptyEnv(),
		});

		expect(result).toEqual({
			kind: "unavailable",
			provider: "claude-sdk-oauth",
			reason: "oauth-not-configured",
		});
		expect(calls).toHaveLength(0);
	});

	it("never sends the managed marker the host projects onto the flat credential", async () => {
		const { fetch, calls } = recordingFetch(() => usageResponse());
		const registry = claudeRegistry([
			{
				name: "poisoned",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
			},
		]);

		const result = await fetchClaudeSdkOauthQuota(registry, { fetch, env: emptyEnv() });

		expect(result).toEqual({
			kind: "unavailable",
			provider: "claude-sdk-oauth",
			reason: "oauth-not-configured",
		});
		expect(calls).toHaveLength(0);
	});

	it("passes through Retry-After on a 429 response", async () => {
		const { fetch } = recordingFetch(() => errorResponse(429, "30"));
		const registry = claudeRegistry([
			{ name: "default", access: SLOT_TOKEN, expires: Date.now() + HOUR_MS },
		]);

		const result = await fetchClaudeSdkOauthQuota(registry, { fetch, env: emptyEnv() });

		expect(result).toEqual({
			kind: "failure",
			provider: "claude-sdk-oauth",
			reason: { type: "http-error", status: 429 },
			retryAfterSeconds: 30,
		});
	});

	it("re-throws the caller's own cancellation instead of returning a result", async () => {
		const controller = new AbortController();
		const registry = claudeRegistry([
			{ name: "default", access: SLOT_TOKEN, expires: Date.now() + HOUR_MS },
		]);
		const fetch: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(init.signal.reason));
			});

		const pending = fetchClaudeSdkOauthQuota(registry, {
			fetch,
			env: emptyEnv(),
			signal: controller.signal,
			timeoutMs: 60_000,
		});
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("never leaks the stored token into any result", async () => {
		const registry = claudeRegistry([
			{ name: "default", access: SLOT_TOKEN, expires: Date.now() + HOUR_MS },
		]);
		const responses: ReadonlyArray<() => HttpResponseLike> = [
			() => errorResponse(401),
			() => errorResponse(429, "30"),
			() => jsonResponse({ five_hour: { utilization: 5 } }),
			() => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => {
					throw new SyntaxError(`bad json for token ${SLOT_TOKEN}`);
				},
			}),
		];

		for (const respond of responses) {
			const { fetch } = recordingFetch(respond);
			const result = await fetchClaudeSdkOauthQuota(registry, { fetch, env: emptyEnv() });

			expect(result.kind).not.toBe("success");
			expect(JSON.stringify(result)).not.toContain(SLOT_TOKEN);
		}
	});
});

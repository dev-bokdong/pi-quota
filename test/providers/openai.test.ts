import { describe, expect, it } from "vitest";
import type { QuotaAuthModel, QuotaModelRegistry } from "../../src/auth.ts";
import type { FetchLike, HttpResponseLike } from "../../src/http.ts";
import { fetchOpenAiQuota } from "../../src/providers/openai.ts";

const SECRET_TOKEN = "sk-test-canary-xyz";

interface FetchCall {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly redirect: string;
}

function fakeRegistry(overrides: Partial<QuotaModelRegistry> = {}): QuotaModelRegistry {
	return {
		getAvailable: () => [{ provider: "openai-codex" } satisfies QuotaAuthModel],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		...overrides,
	};
}

function recordingFetch(respond: () => Promise<HttpResponseLike>): {
	fetch: FetchLike;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, headers: init.headers, redirect: init.redirect });
		return respond();
	};
	return { fetch, calls };
}

function neverResolvingFetch(): FetchLike {
	return (_url, init) =>
		new Promise((_resolve, reject) => {
			if (init.signal.aborted) {
				reject(init.signal.reason);
				return;
			}
			init.signal.addEventListener("abort", () => reject(init.signal.reason));
		});
}

function jsonResponse(body: unknown): () => Promise<HttpResponseLike> {
	return async () => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => body,
	});
}

function errorResponse(status: number, retryAfter?: string): () => Promise<HttpResponseLike> {
	return async () => ({
		ok: false,
		status,
		headers: {
			get: (name: string) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
		},
		json: async () => {
			throw new Error("body must never be read");
		},
	});
}

const RESET_AT_SECONDS = 1_800_000_000;
const RESET_AT_MS = RESET_AT_SECONDS * 1000;

describe("fetchOpenAiQuota", () => {
	it("returns every quota window from a full usage response", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "business",
				rate_limit: {
					limit_reached: false,
					primary_window: {
						used_percent: 18,
						limit_window_seconds: 18_000,
						reset_at: RESET_AT_SECONDS,
						reset_after_seconds: 60,
					},
					secondary_window: {
						used_percent: 39,
						limit_window_seconds: 604_800,
						reset_at: RESET_AT_SECONDS + 100,
					},
				},
				code_review_rate_limit: {
					primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
				},
				spend_control: {
					individual_limit: { remaining_percent: 44, reset_at: RESET_AT_SECONDS + 200 },
				},
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "success",
			provider: "openai-codex",
			displayName: "OpenAI",
			windows: [
				{ label: "Five-hour", remainingPercent: 82, resetAt: new Date(RESET_AT_MS) },
				{ label: "Weekly", remainingPercent: 61, resetAt: new Date(RESET_AT_MS + 100_000) },
				{ label: "Monthly", remainingPercent: 44, resetAt: new Date(RESET_AT_MS + 200_000) },
				{ label: "Code Review", remainingPercent: 75 },
			],
		});
	});

	it("prefers reset_at over reset_after_seconds and falls back when reset_at is absent", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "pro",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 0 },
					secondary_window: {
						used_percent: 20,
						limit_window_seconds: 604_800,
						reset_after_seconds: 3600,
					},
				},
			}),
		);

		const before = Date.now();
		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });
		const after = Date.now();

		expect(result.kind).toBe("success");
		if (result.kind !== "success") return;
		const [fiveHour, weekly] = result.windows;
		expect(fiveHour).toEqual({ label: "Five-hour", remainingPercent: 90 });
		expect(weekly?.label).toBe("Weekly");
		expect(weekly?.remainingPercent).toBe(80);
		expect(weekly?.resetAt?.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(weekly?.resetAt?.getTime()).toBeLessThanOrEqual(after + 3_600_000);
	});

	it("keeps a single window when both rate limit windows agree on the same kind", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "plus",
				rate_limit: {
					limit_reached: false,
					primary_window: {
						used_percent: 30,
						limit_window_seconds: 18_000,
						reset_at: RESET_AT_SECONDS,
					},
					secondary_window: {
						used_percent: 30,
						limit_window_seconds: 18_000,
						reset_at: RESET_AT_SECONDS,
					},
				},
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "success",
			provider: "openai-codex",
			displayName: "OpenAI",
			windows: [{ label: "Five-hour", remainingPercent: 70, resetAt: new Date(RESET_AT_MS) }],
		});
	});

	it("drops a conflicting window kind instead of guessing between the two values", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "plus",
				rate_limit: {
					limit_reached: false,
					primary_window: {
						used_percent: 30,
						limit_window_seconds: 18_000,
						reset_at: RESET_AT_SECONDS,
					},
					secondary_window: {
						used_percent: 70,
						limit_window_seconds: 18_000,
						reset_at: RESET_AT_SECONDS,
					},
				},
				code_review_rate_limit: { primary_window: { used_percent: 5 } },
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "success",
			provider: "openai-codex",
			displayName: "OpenAI",
			windows: [{ label: "Code Review", remainingPercent: 95 }],
		});
	});

	it("does not let spend_control override a monthly window from the rate limits", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "pro",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 10, limit_window_seconds: 2_628_000 },
				},
				spend_control: { individual_limit: { remaining_percent: 3 } },
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "success",
			provider: "openai-codex",
			displayName: "OpenAI",
			windows: [{ label: "Monthly", remainingPercent: 90 }],
		});
	});

	it("reports unavailable without making any request when OAuth is not configured", async () => {
		const { fetch, calls } = recordingFetch(jsonResponse({}));
		const registry = fakeRegistry({ getAvailable: () => [] });

		const result = await fetchOpenAiQuota(registry, { fetch });

		expect(result).toEqual({
			kind: "unavailable",
			provider: "openai-codex",
			reason: "oauth-not-configured",
		});
		expect(calls).toHaveLength(0);
	});

	it("reports unsupported-auth-method without making any request for API key auth", async () => {
		const { fetch, calls } = recordingFetch(jsonResponse({}));
		const registry = fakeRegistry({ isUsingOAuth: () => false });

		const result = await fetchOpenAiQuota(registry, { fetch });

		expect(result).toEqual({
			kind: "unavailable",
			provider: "openai-codex",
			reason: "unsupported-auth-method",
		});
		expect(calls).toHaveLength(0);
	});

	it("maps a 401 response to an http-error failure", async () => {
		const { fetch } = recordingFetch(errorResponse(401));

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 401 },
		});
	});

	it("maps a 500 response to an http-error failure", async () => {
		const { fetch } = recordingFetch(errorResponse(500));

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 500 },
		});
	});

	it("carries Retry-After seconds on a 429 failure", async () => {
		const { fetch } = recordingFetch(errorResponse(429, "30"));

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "http-error", status: 429 },
			retryAfterSeconds: 30,
		});
	});

	it("maps a rejected JSON body to an invalid-response failure", async () => {
		const { fetch } = recordingFetch(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => {
				throw new SyntaxError("Unexpected token < in JSON");
			},
		}));

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "invalid-response" },
		});
	});

	it("maps a non-object JSON body to an invalid-response failure", async () => {
		const { fetch } = recordingFetch(jsonResponse("not an object"));

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "invalid-response" },
		});
	});

	it("maps a network error to a network-error failure", async () => {
		const fetch: FetchLike = async () => {
			throw new TypeError("fetch failed");
		};

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "network-error" },
		});
	});

	it("maps an exceeded request deadline to a timeout failure", async () => {
		const result = await fetchOpenAiQuota(fakeRegistry(), {
			fetch: neverResolvingFetch(),
			timeoutMs: 10,
		});

		expect(result).toEqual({
			kind: "failure",
			provider: "openai-codex",
			reason: { type: "timeout" },
		});
	});

	it("propagates the caller's own cancellation instead of returning a result", async () => {
		const controller = new AbortController();

		const pending = fetchOpenAiQuota(fakeRegistry(), {
			fetch: neverResolvingFetch(),
			signal: controller.signal,
			timeoutMs: 60_000,
		});
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("reports no-quota-windows when the response carries no usable window", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "free",
				rate_limit: null,
				code_review_rate_limit: null,
				spend_control: null,
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "unavailable",
			provider: "openai-codex",
			reason: "no-quota-windows",
		});
	});

	it("reports no-quota-windows when every window has an unusable shape", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "plus",
				rate_limit: {
					limit_reached: true,
					primary_window: { used_percent: "nope", limit_window_seconds: 18_000 },
					secondary_window: { used_percent: 10, limit_window_seconds: 42 },
				},
				code_review_rate_limit: { primary_window: null },
				spend_control: { individual_limit: { remaining_percent: null } },
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "unavailable",
			provider: "openai-codex",
			reason: "no-quota-windows",
		});
	});

	it("clamps out-of-range percentages into the 0-100 range", async () => {
		const { fetch } = recordingFetch(
			jsonResponse({
				plan_type: "pro",
				rate_limit: {
					limit_reached: true,
					primary_window: { used_percent: 140, limit_window_seconds: 18_000 },
					secondary_window: { used_percent: -25, limit_window_seconds: 604_800 },
				},
				spend_control: { individual_limit: { remaining_percent: 900 } },
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result).toEqual({
			kind: "success",
			provider: "openai-codex",
			displayName: "OpenAI",
			windows: [
				{ label: "Five-hour", remainingPercent: 0 },
				{ label: "Weekly", remainingPercent: 100 },
				{ label: "Monthly", remainingPercent: 100 },
			],
		});
	});

	it("sends the usage request with the documented URL, auth header and redirect policy", async () => {
		const { fetch, calls } = recordingFetch(
			jsonResponse({
				plan_type: "pro",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 1, limit_window_seconds: 18_000 },
				},
			}),
		);

		await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(calls).toHaveLength(1);
		const call = calls[0] as FetchCall;
		expect(call.url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(call.headers["Authorization"]).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(call.redirect).toBe("error");
	});

	it("omits the account header when no account id can be extracted from the token", async () => {
		const { fetch, calls } = recordingFetch(
			jsonResponse({
				plan_type: "pro",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 1, limit_window_seconds: 18_000 },
				},
			}),
		);

		const result = await fetchOpenAiQuota(fakeRegistry(), { fetch });

		expect(result.kind).toBe("success");
		expect(calls).toHaveLength(1);
		expect((calls[0] as FetchCall).headers).not.toHaveProperty("ChatGPT-Account-Id");
	});

	it("never leaks the access token into any non-success result", async () => {
		const leakyRegistry = fakeRegistry({
			getApiKeyAndHeaders: async () => {
				throw new Error(`token ${SECRET_TOKEN} is expired`);
			},
		});
		const results = [
			await fetchOpenAiQuota(leakyRegistry, { fetch: recordingFetch(jsonResponse({})).fetch }),
			await fetchOpenAiQuota(fakeRegistry(), { fetch: recordingFetch(errorResponse(401)).fetch }),
			await fetchOpenAiQuota(fakeRegistry(), { fetch: recordingFetch(errorResponse(500)).fetch }),
			await fetchOpenAiQuota(fakeRegistry(), {
				fetch: recordingFetch(jsonResponse("not an object")).fetch,
			}),
			await fetchOpenAiQuota(fakeRegistry(), {
				fetch: recordingFetch(jsonResponse({ plan_type: "free", rate_limit: null })).fetch,
			}),
			await fetchOpenAiQuota(fakeRegistry(), {
				fetch: async () => {
					throw new TypeError(`fetch failed for ${SECRET_TOKEN}`);
				},
			}),
		];

		for (const result of results) {
			expect(result.kind).not.toBe("success");
			expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
		}
	});
});

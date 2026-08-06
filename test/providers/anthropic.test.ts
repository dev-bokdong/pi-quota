import { describe, expect, it } from "vitest";
import type { QuotaModelRegistry } from "../../src/auth.ts";
import type { FetchLike, HttpResponseLike } from "../../src/http.ts";
import { fetchAnthropicQuota } from "../../src/providers/anthropic.ts";

const SECRET_TOKEN = "sk-ant-oat-canary-should-never-leak-9f3c";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

interface FetchCall {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly redirect: string;
}

function oauthRegistry(): QuotaModelRegistry {
	return {
		getAvailable: () => [{ provider: "anthropic" }],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
	};
}

function emptyRegistry(): QuotaModelRegistry {
	return {
		getAvailable: () => [],
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: false }),
	};
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

function jsonResponse(body: unknown): HttpResponseLike {
	return {
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => body,
	};
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

describe("fetchAnthropicQuota", () => {
	it("returns both windows for a snake_case usage response", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({
				five_hour: { utilization: 26, resets_at: "2026-08-06T12:00:00Z" },
				seven_day: { utilization: 52.4, resets_at: "2026-08-10T12:00:00Z" },
			}),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "success",
			provider: "anthropic",
			displayName: "Anthropic",
			windows: [
				{
					label: "Five-hour",
					remainingPercent: 74,
					resetAt: new Date("2026-08-06T12:00:00Z"),
				},
				{
					label: "Weekly",
					remainingPercent: 48,
					resetAt: new Date("2026-08-10T12:00:00Z"),
				},
			],
		});
	});

	it("returns both windows for a camelCase usage response", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({
				fiveHour: { utilization: 10, resetsAt: "2026-08-06T15:30:00Z" },
				sevenDay: { utilization: 40, resetAt: "2026-08-11T00:00:00Z" },
			}),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "success",
			provider: "anthropic",
			displayName: "Anthropic",
			windows: [
				{
					label: "Five-hour",
					remainingPercent: 90,
					resetAt: new Date("2026-08-06T15:30:00Z"),
				},
				{
					label: "Weekly",
					remainingPercent: 60,
					resetAt: new Date("2026-08-11T00:00:00Z"),
				},
			],
		});
	});

	it("omits resetAt when the reset timestamp is not parseable", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({
				five_hour: { utilization: 0, resets_at: "not-a-date" },
				seven_day: { utilization: 100 },
			}),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "success",
			provider: "anthropic",
			displayName: "Anthropic",
			windows: [
				{ label: "Five-hour", remainingPercent: 100 },
				{ label: "Weekly", remainingPercent: 0 },
			],
		});
	});

	it("reports no-quota-windows when only the five hour window is present", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({ five_hour: { utilization: 26, resets_at: "2026-08-06T12:00:00Z" } }),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "unavailable",
			provider: "anthropic",
			reason: "no-quota-windows",
		});
	});

	it("reports no-quota-windows when the seven day utilization is not numeric", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({
				five_hour: { utilization: 26 },
				seven_day: { utilization: "52" },
			}),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "unavailable",
			provider: "anthropic",
			reason: "no-quota-windows",
		});
	});

	it("reports no-quota-windows when a window is not an object", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({ five_hour: 26, seven_day: { utilization: 52 } }),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "unavailable",
			provider: "anthropic",
			reason: "no-quota-windows",
		});
	});

	it("passes through Retry-After on a 429 response", async () => {
		const { fetch } = recordingFetch(() => errorResponse(429, "30"));
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "failure",
			provider: "anthropic",
			reason: { type: "http-error", status: 429 },
			retryAfterSeconds: 30,
		});
	});

	it("reports invalid-response when the body is malformed JSON", async () => {
		const { fetch } = recordingFetch(() => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => {
				throw new SyntaxError(`Unexpected token in JSON near ${SECRET_TOKEN}`);
			},
		}));
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "failure",
			provider: "anthropic",
			reason: { type: "invalid-response" },
		});
	});

	it("reports invalid-response when the payload is not an object", async () => {
		const { fetch } = recordingFetch(() => jsonResponse("nope"));
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "failure",
			provider: "anthropic",
			reason: { type: "invalid-response" },
		});
	});

	it("reports http-error with the status for 401 and 500 responses", async () => {
		for (const status of [401, 500]) {
			const { fetch } = recordingFetch(() => errorResponse(status));
			const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
			expect(result).toEqual({
				kind: "failure",
				provider: "anthropic",
				reason: { type: "http-error", status },
			});
		}
	});

	it("reports timeout when the request exceeds the HTTP timeout", async () => {
		const result = await fetchAnthropicQuota(oauthRegistry(), {
			fetch: neverResolvingFetch(),
			timeoutMs: 5,
		});
		expect(result).toEqual({
			kind: "failure",
			provider: "anthropic",
			reason: { type: "timeout" },
		});
	});

	it("reports network-error when the fetch call itself rejects", async () => {
		const { fetch } = recordingFetch(() => {
			throw new TypeError("fetch failed");
		});
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "failure",
			provider: "anthropic",
			reason: { type: "network-error" },
		});
	});

	it("re-throws the caller's own cancellation instead of returning a result", async () => {
		const controller = new AbortController();
		const pending = fetchAnthropicQuota(oauthRegistry(), {
			fetch: neverResolvingFetch(),
			signal: controller.signal,
			timeoutMs: 60_000,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("reports unavailable and makes no HTTP call when OAuth is not configured", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse({}));
		const result = await fetchAnthropicQuota(emptyRegistry(), { fetch });
		expect(result).toEqual({
			kind: "unavailable",
			provider: "anthropic",
			reason: "oauth-not-configured",
		});
		expect(calls).toHaveLength(0);
	});

	it("reports unsupported-auth-method for an API-key model without calling HTTP", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse({}));
		const registry: QuotaModelRegistry = {
			getAvailable: () => [{ provider: "anthropic" }],
			isUsingOAuth: () => false,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		};
		const result = await fetchAnthropicQuota(registry, { fetch });
		expect(result).toEqual({
			kind: "unavailable",
			provider: "anthropic",
			reason: "unsupported-auth-method",
		});
		expect(calls).toHaveLength(0);
	});

	it("clamps out-of-range utilization values into 0-100 remaining percent", async () => {
		const { fetch } = recordingFetch(() =>
			jsonResponse({
				five_hour: { utilization: 140 },
				seven_day: { utilization: -25 },
			}),
		);
		const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(result).toEqual({
			kind: "success",
			provider: "anthropic",
			displayName: "Anthropic",
			windows: [
				{ label: "Five-hour", remainingPercent: 0 },
				{ label: "Weekly", remainingPercent: 100 },
			],
		});
	});

	it("never leaks the access token into any failure or unavailable result", async () => {
		const responses: Array<() => HttpResponseLike> = [
			() => errorResponse(429, "30"),
			() => errorResponse(401),
			() => errorResponse(500),
			() => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => {
					throw new SyntaxError(`bad json for token ${SECRET_TOKEN}`);
				},
			}),
			() => jsonResponse({ five_hour: { utilization: 5 } }),
		];
		for (const respond of responses) {
			const { fetch } = recordingFetch(respond);
			const result = await fetchAnthropicQuota(oauthRegistry(), { fetch });
			expect(result.kind).not.toBe("success");
			expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
		}

		const unavailable = await fetchAnthropicQuota(emptyRegistry(), {
			fetch: recordingFetch(() => jsonResponse({})).fetch,
		});
		expect(JSON.stringify(unavailable)).not.toContain(SECRET_TOKEN);
	});

	it("requests the OAuth usage endpoint with the documented headers", async () => {
		const { fetch, calls } = recordingFetch(() =>
			jsonResponse({
				five_hour: { utilization: 26 },
				seven_day: { utilization: 52 },
			}),
		);
		await fetchAnthropicQuota(oauthRegistry(), { fetch });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			url: USAGE_URL,
			headers: {
				Authorization: `Bearer ${SECRET_TOKEN}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			redirect: "error",
		});
	});
});

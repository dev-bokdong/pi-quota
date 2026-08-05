import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/http.ts";
import { fetchJson, HttpNetworkError, HttpStatusError, HttpTimeoutError } from "../src/http.ts";

const BODY_CANARY = "leaked-secret-body-marker";

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

describe("fetchJson", () => {
	it("returns parsed JSON on a 200 response and forwards headers/redirect policy", async () => {
		const calls: Array<[string, { headers: Readonly<Record<string, string>>; redirect: string }]> =
			[];
		const fetch: FetchLike = async (url, init) => {
			calls.push([url, init]);
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({ hello: "world" }),
			};
		};
		const result = await fetchJson("https://example.test/usage", {
			headers: { Authorization: "Bearer token" },
			fetch,
		});
		expect(result).toEqual({ hello: "world" });
		expect(calls).toHaveLength(1);
		const [url, init] = calls[0] as [string, { headers: Record<string, string>; redirect: string }];
		expect(url).toBe("https://example.test/usage");
		expect(init.headers).toEqual({ Authorization: "Bearer token" });
		expect(init.redirect).toBe("error");
	});

	it("throws HttpStatusError with the status and Retry-After without reading the body", async () => {
		const fetch: FetchLike = async () => ({
			ok: false,
			status: 429,
			headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? "30" : null) },
			json: async () => {
				throw new Error(`must not be called: ${BODY_CANARY}`);
			},
		});
		await expect(
			fetchJson("https://example.test/usage", { headers: {}, fetch }),
		).rejects.toMatchObject({
			name: "HttpStatusError",
			status: 429,
			retryAfterSeconds: 30,
		});
	});

	it("never includes the response body in the thrown status error message", async () => {
		const fetch: FetchLike = async () => ({
			ok: false,
			status: 500,
			headers: { get: () => null },
			json: async () => ({ error: BODY_CANARY }),
		});
		let caught: unknown;
		try {
			await fetchJson("https://example.test/usage", { headers: {}, fetch });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HttpStatusError);
		expect(String((caught as Error).message)).not.toContain(BODY_CANARY);
	});

	it("throws HttpTimeoutError when the request exceeds timeoutMs", async () => {
		await expect(
			fetchJson("https://example.test/usage", {
				headers: {},
				fetch: neverResolvingFetch(),
				timeoutMs: 10,
			}),
		).rejects.toThrow(HttpTimeoutError);
	});

	it("propagates the caller's own cancellation without wrapping it", async () => {
		const controller = new AbortController();
		const pending = fetchJson("https://example.test/usage", {
			headers: {},
			fetch: neverResolvingFetch(),
			signal: controller.signal,
			timeoutMs: 60_000,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("throws HttpNetworkError when the fetch call itself rejects", async () => {
		const fetch: FetchLike = async () => {
			throw new TypeError(`fetch failed: ${BODY_CANARY}`);
		};
		let caught: unknown;
		try {
			await fetchJson("https://example.test/usage", { headers: {}, fetch });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(HttpNetworkError);
		expect(String((caught as Error).message)).not.toContain(BODY_CANARY);
	});
});

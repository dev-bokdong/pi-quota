import { describe, expect, it } from "vitest";
import type { QuotaAuthModel, QuotaModelRegistry } from "../src/auth.ts";
import { resolveOAuthCredentials } from "../src/auth.ts";

const SECRET_TOKEN = "sk-test-secret-token-should-never-leak";

function fakeRegistry(overrides: Partial<QuotaModelRegistry>): QuotaModelRegistry {
	return {
		getAvailable: () => [],
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: false }),
		...overrides,
	};
}

describe("resolveOAuthCredentials", () => {
	it("reports oauth-not-configured when no model exists for the provider", async () => {
		const registry = fakeRegistry({ getAvailable: () => [{ provider: "anthropic" }] });
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
	});

	it("reports unsupported-auth-method when the model uses an API key instead of OAuth", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => false,
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: false, reason: "unsupported-auth-method" });
	});

	it("reports oauth-not-configured when OAuth is active but no token resolves", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
	});

	it("reports oauth-not-configured when the auth resolution itself fails", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: false }),
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
	});

	it("returns the access token when OAuth resolves successfully", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: true, credentials: { accessToken: SECRET_TOKEN } });
	});

	it("matches the model by provider id among multiple available models", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "anthropic" }, { provider: "openai-codex" }],
			isUsingOAuth: (model: QuotaAuthModel) => model.provider === "openai-codex",
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: true, credentials: { accessToken: SECRET_TOKEN } });
	});

	it("never leaks an underlying error message when auth resolution throws", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => {
				throw new Error(`token ${SECRET_TOKEN} expired`);
			},
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});
});

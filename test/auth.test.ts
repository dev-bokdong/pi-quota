import { describe, expect, it } from "vitest";
import type { QuotaAuthModel, QuotaModelRegistry } from "../src/auth.ts";
import { listQuotaAccounts, resolveOAuthCredentials } from "../src/auth.ts";

const SECRET_TOKEN = "sk-test-secret-token-should-never-leak";
const ACCOUNT_TOKEN = "sk-test-account-token-should-never-leak";

function fakeRegistry(overrides: Partial<QuotaModelRegistry>): QuotaModelRegistry {
	return {
		getAvailable: () => [],
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: false }),
		...overrides,
	};
}

interface SlotAuthCall {
	readonly provider: unknown;
	readonly overrides: unknown;
}

/** Registry whose host carries the credential-pool members. */
function pooledRegistry(options: {
	readonly slots?: unknown;
	readonly listSlots?: (provider: string) => unknown;
	readonly slotAuth?: (provider: string, slotName: string) => unknown;
	readonly calls?: SlotAuthCall[];
}): QuotaModelRegistry {
	return fakeRegistry({
		getAvailable: () => [{ provider: "openai-codex" }],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		authStorage: {
			listSlots: options.listSlots ?? ((_provider: string) => options.slots ?? []),
		},
		modelRuntime: {
			getAuth: async (provider: unknown, overrides: unknown) => {
				options.calls?.push({ provider, overrides });
				const slotName =
					typeof overrides === "object" && overrides !== null
						? Reflect.get(overrides, "slotName")
						: undefined;
				if (typeof provider !== "string" || typeof slotName !== "string") return undefined;
				return options.slotAuth?.(provider, slotName);
			},
		},
	});
}

describe("listQuotaAccounts", () => {
	it("returns no accounts on a host without credential pools", () => {
		const registry = fakeRegistry({ getAvailable: () => [{ provider: "openai-codex" }] });
		expect(listQuotaAccounts(registry, "openai-codex")).toEqual([]);
	});

	it("returns no accounts for a provider that pools only one", () => {
		const registry = pooledRegistry({ slots: [{ name: "default" }] });
		expect(listQuotaAccounts(registry, "openai-codex")).toEqual([]);
	});

	it("labels each account by display name and falls back to the slot name", () => {
		const registry = pooledRegistry({
			slots: [{ name: "default" }, { name: "login-2", displayName: "work" }],
		});

		expect(listQuotaAccounts(registry, "openai-codex")).toEqual([
			{ name: "default", label: "default" },
			{ name: "login-2", label: "work" },
		]);
	});

	it("asks the storage for the requested provider only", () => {
		const providers: string[] = [];
		const registry = pooledRegistry({
			listSlots: (provider: string) => {
				providers.push(provider);
				return [{ name: "default" }, { name: "login-2" }];
			},
		});

		listQuotaAccounts(registry, "anthropic");
		expect(providers).toEqual(["anthropic"]);
	});

	it("drops malformed slots and needs more than one usable account", () => {
		const registry = pooledRegistry({
			slots: [{ name: "default" }, { name: "" }, { displayName: "nameless" }, null, "login-3"],
		});

		expect(listQuotaAccounts(registry, "openai-codex")).toEqual([]);
	});

	it("returns no accounts when the listing throws or answers with a non-list", () => {
		const throwing = pooledRegistry({
			listSlots: () => {
				throw new Error(`pool read failed for ${SECRET_TOKEN}`);
			},
		});
		const wrongShape = pooledRegistry({ slots: { default: {} } });

		expect(listQuotaAccounts(throwing, "openai-codex")).toEqual([]);
		expect(listQuotaAccounts(wrongShape, "openai-codex")).toEqual([]);
	});
});

describe("resolveOAuthCredentials for one account", () => {
	it("resolves the named account's token through slot-scoped host auth", async () => {
		const calls: SlotAuthCall[] = [];
		const registry = pooledRegistry({
			calls,
			slotAuth: (_provider, slotName) =>
				slotName === "login-2" ? { auth: { apiKey: ACCOUNT_TOKEN } } : undefined,
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "login-2");

		expect(result).toEqual({ ok: true, credentials: { accessToken: ACCOUNT_TOKEN } });
		expect(calls).toEqual([{ provider: "openai-codex", overrides: { slotName: "login-2" } }]);
	});

	it("never falls back to the flat credential when the account resolves nothing", async () => {
		const registry = pooledRegistry({ slotAuth: () => ({ auth: {} }) });

		const result = await resolveOAuthCredentials(registry, "openai-codex", "login-2");

		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
	});

	it("reports oauth-not-configured when the host has no slot-scoped auth", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "login-2");

		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
	});

	it("reports unsupported-auth-method for an API-key provider before reading accounts", async () => {
		const calls: SlotAuthCall[] = [];
		const registry = fakeRegistry({
			...pooledRegistry({ calls, slotAuth: () => ({ auth: { apiKey: ACCOUNT_TOKEN } }) }),
			isUsingOAuth: () => false,
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "login-2");

		expect(result).toEqual({ ok: false, reason: "unsupported-auth-method" });
		expect(calls).toEqual([]);
	});

	it("never leaks an underlying error message when slot auth throws", async () => {
		const registry = pooledRegistry({
			slotAuth: () => {
				throw new Error(`token ${ACCOUNT_TOKEN} expired`);
			},
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "login-2");

		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
		expect(JSON.stringify(result)).not.toContain(ACCOUNT_TOKEN);
	});
});

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

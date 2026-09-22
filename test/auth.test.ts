import { describe, expect, it } from "vitest";
import type { EnvReader, QuotaAuthModel, QuotaModelRegistry } from "../src/auth.ts";
import {
	listClaudeSdkOauthAccounts,
	listQuotaAccounts,
	resolveClaudeSdkOauthCredentials,
	resolveOAuthCredentials,
} from "../src/auth.ts";

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

	it("reads the sole pooled account through the flat credential without slot-scoped auth", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
			authStorage: { listSlots: () => [{ name: "default" }] },
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "default");

		expect(result).toEqual({ ok: true, credentials: { accessToken: SECRET_TOKEN } });
	});

	it("refuses the flat credential for a pool of several accounts without slot-scoped auth", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "openai-codex" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
			authStorage: { listSlots: () => [{ name: "default" }, { name: "login-2" }] },
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "default");

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

	it("resolves a provider the host has renamed", async () => {
		const registry = fakeRegistry({
			getAvailable: () => [{ provider: "chatgpt-subscription" }],
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
		});
		const result = await resolveOAuthCredentials(registry, "openai-codex");
		expect(result).toEqual({ ok: true, credentials: { accessToken: SECRET_TOKEN } });
	});

	it("asks slot-scoped auth under the host's own spelling of the provider", async () => {
		const calls: SlotAuthCall[] = [];
		const registry = fakeRegistry({
			...pooledRegistry({ calls, slotAuth: () => ({ auth: { apiKey: ACCOUNT_TOKEN } }) }),
			getAvailable: () => [{ provider: "chatgpt-subscription" }],
		});

		const result = await resolveOAuthCredentials(registry, "openai-codex", "login-2");

		expect(result).toEqual({ ok: true, credentials: { accessToken: ACCOUNT_TOKEN } });
		expect(calls).toEqual([
			{ provider: "chatgpt-subscription", overrides: { slotName: "login-2" } },
		]);
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

const CLAUDE_TOKEN = "sk-ant-oat-claude-canary-should-never-leak";
const CLAUDE_SENTINEL = "claude-sdk-oauth-managed";
const HOUR_MS = 60 * 60 * 1000;

const noEnv: EnvReader = () => undefined;

/** Host whose Claude SDK OAuth credential pools the given slots. */
function claudeRegistry(options: {
	readonly slots?: unknown;
	readonly listSlots?: (provider: string) => unknown;
}): QuotaModelRegistry {
	return fakeRegistry({
		getAvailable: () => [{ provider: "claude-sdk-oauth" }],
		isUsingOAuth: () => true,
		// The host resolves this provider's auth to a marker, never a token.
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: CLAUDE_SENTINEL }),
		authStorage: {
			listSlots:
				options.listSlots ??
				((provider: string) => (provider === "claude-sdk-oauth" ? (options.slots ?? []) : [])),
		},
	});
}

function usableSlot(name: string, token: string, displayName?: string): unknown {
	return {
		name,
		access: token,
		refresh: `${token}-refresh`,
		expires: Date.now() + HOUR_MS,
		source: "login",
		...(displayName === undefined ? {} : { displayName }),
	};
}

describe("listClaudeSdkOauthAccounts", () => {
	it("lists every account that holds a token, including a lone one", () => {
		const single = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });
		const pooled = claudeRegistry({
			slots: [usableSlot("default", CLAUDE_TOKEN), usableSlot("login-2", CLAUDE_TOKEN, "work")],
		});

		expect(listClaudeSdkOauthAccounts(single, noEnv)).toEqual([
			{ name: "default", label: "default" },
		]);
		expect(listClaudeSdkOauthAccounts(pooled, noEnv)).toEqual([
			{ name: "default", label: "default" },
			{ name: "login-2", label: "work" },
		]);
	});

	it("lists an expired account, which is configured but cannot be read", () => {
		const registry = claudeRegistry({
			slots: [{ name: "default", access: CLAUDE_TOKEN, expires: Date.now() - HOUR_MS }],
		});

		expect(listClaudeSdkOauthAccounts(registry, noEnv)).toEqual([
			{ name: "default", label: "default" },
		]);
	});

	it("ignores the managed marker and slots that carry no token", () => {
		const registry = claudeRegistry({
			slots: [
				{ name: "poisoned", access: CLAUDE_SENTINEL, refresh: CLAUDE_SENTINEL },
				{ name: "empty", access: "" },
				{ name: "absent" },
				{ access: CLAUDE_TOKEN },
				null,
			],
		});

		expect(listClaudeSdkOauthAccounts(registry, noEnv)).toEqual([]);
	});

	it("reads this provider's own ids only, the host's newest spelling first", () => {
		const providers: string[] = [];
		const registry = claudeRegistry({
			listSlots: (provider: string) => {
				providers.push(provider);
				return provider === "claude-sdk-oauth" ? [usableSlot("default", CLAUDE_TOKEN)] : [];
			},
		});

		expect(listClaudeSdkOauthAccounts(registry, noEnv)).toEqual([
			{ name: "default", label: "default" },
		]);
		expect(providers).toEqual(["anthropic-subscription", "claude-sdk-oauth"]);
	});

	it("reads the slots of a host that renamed the provider", () => {
		const registry = claudeRegistry({
			listSlots: (provider: string) =>
				provider === "anthropic-subscription" ? [usableSlot("default", CLAUDE_TOKEN)] : [],
		});

		expect(listClaudeSdkOauthAccounts(registry, noEnv)).toEqual([
			{ name: "default", label: "default" },
		]);
	});

	it("lists environment accounts under the host's own account names", () => {
		const env: EnvReader = (name) =>
			name === "CLAUDE_CODE_OAUTH_TOKEN"
				? CLAUDE_TOKEN
				: name === "CLAUDE_CODE_OAUTH_TOKEN_3"
					? `${CLAUDE_TOKEN}-3`
					: undefined;

		expect(listClaudeSdkOauthAccounts(claudeRegistry({}), env)).toEqual([
			{ name: "env", label: "env" },
			{ name: "env-3", label: "env-3" },
		]);
	});

	it("returns no accounts on a host without credential pools or env tokens", () => {
		const registry = fakeRegistry({ getAvailable: () => [{ provider: "claude-sdk-oauth" }] });

		expect(listClaudeSdkOauthAccounts(registry, noEnv)).toEqual([]);
	});

	it("returns no accounts when the slot listing throws or answers with a non-list", () => {
		const throwing = claudeRegistry({
			listSlots: () => {
				throw new Error(`pool read failed for ${CLAUDE_TOKEN}`);
			},
		});
		const wrongShape = claudeRegistry({ slots: { default: {} } });

		expect(listClaudeSdkOauthAccounts(throwing, noEnv)).toEqual([]);
		expect(listClaudeSdkOauthAccounts(wrongShape, noEnv)).toEqual([]);
	});
});

describe("resolveClaudeSdkOauthCredentials", () => {
	it("resolves the only account without being given a name", () => {
		const registry = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });

		expect(resolveClaudeSdkOauthCredentials(registry, undefined, noEnv)).toEqual({
			ok: true,
			credentials: { accessToken: CLAUDE_TOKEN },
		});
	});

	it("resolves the named account's own token", () => {
		const registry = claudeRegistry({
			slots: [
				usableSlot("default", `${CLAUDE_TOKEN}-default`),
				usableSlot("login-2", `${CLAUDE_TOKEN}-login-2`, "work"),
			],
		});

		expect(resolveClaudeSdkOauthCredentials(registry, "login-2", noEnv)).toEqual({
			ok: true,
			credentials: { accessToken: `${CLAUDE_TOKEN}-login-2` },
		});
	});

	it("never falls back to a sibling account when the named one is unknown", () => {
		const registry = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });

		const result = resolveClaudeSdkOauthCredentials(registry, "login-2", noEnv);

		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
		expect(JSON.stringify(result)).not.toContain(CLAUDE_TOKEN);
	});

	it("reports oauth-not-configured when the lane has no account at all", () => {
		expect(resolveClaudeSdkOauthCredentials(claudeRegistry({}), undefined, noEnv)).toEqual({
			ok: false,
			reason: "oauth-not-configured",
		});
	});

	it("reports token-expired instead of sending a stale token", () => {
		const registry = claudeRegistry({
			slots: [{ name: "default", access: CLAUDE_TOKEN, expires: Date.now() - 1000 }],
		});

		const result = resolveClaudeSdkOauthCredentials(registry, undefined, noEnv);

		expect(result).toEqual({ ok: false, reason: "token-expired" });
		expect(JSON.stringify(result)).not.toContain(CLAUDE_TOKEN);
	});

	it("uses an account whose source reports no expiry", () => {
		const registry = claudeRegistry({
			slots: [{ name: "default", access: CLAUDE_TOKEN, expires: 0 }],
		});

		expect(resolveClaudeSdkOauthCredentials(registry, undefined, noEnv)).toEqual({
			ok: true,
			credentials: { accessToken: CLAUDE_TOKEN },
		});
	});

	it("prefers a stored account over an environment account of the same name", () => {
		const registry = claudeRegistry({ slots: [usableSlot("env", `${CLAUDE_TOKEN}-stored`)] });
		const env: EnvReader = (name) =>
			name === "CLAUDE_CODE_OAUTH_TOKEN" ? `${CLAUDE_TOKEN}-env` : undefined;

		expect(resolveClaudeSdkOauthCredentials(registry, "env", env)).toEqual({
			ok: true,
			credentials: { accessToken: `${CLAUDE_TOKEN}-stored` },
		});
	});

	it("resolves an environment account by name", () => {
		const env: EnvReader = (name) =>
			name === "CLAUDE_CODE_OAUTH_TOKEN_2" ? `${CLAUDE_TOKEN}-2` : undefined;

		expect(resolveClaudeSdkOauthCredentials(claudeRegistry({}), "env-2", env)).toEqual({
			ok: true,
			credentials: { accessToken: `${CLAUDE_TOKEN}-2` },
		});
	});

	it("ignores an environment reader that throws", () => {
		const registry = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });
		const env: EnvReader = () => {
			throw new Error(`env read failed for ${CLAUDE_TOKEN}`);
		};

		expect(resolveClaudeSdkOauthCredentials(registry, undefined, env)).toEqual({
			ok: true,
			credentials: { accessToken: CLAUDE_TOKEN },
		});
	});
});

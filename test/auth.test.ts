import { describe, expect, it } from "vitest";
import type {
	EnvReader,
	QuotaAuthModel,
	QuotaModelRegistry,
	RefreshedTokens,
	TokenRefresher,
} from "../src/auth.ts";
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

describe("resolveClaudeSdkOauthCredentials", async () => {
	it("resolves the only account without being given a name", async () => {
		const registry = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });

		expect(await resolveClaudeSdkOauthCredentials(registry, undefined, noEnv)).toEqual({
			ok: true,
			credentials: { accessToken: CLAUDE_TOKEN },
		});
	});

	it("resolves the named account's own token", async () => {
		const registry = claudeRegistry({
			slots: [
				usableSlot("default", `${CLAUDE_TOKEN}-default`),
				usableSlot("login-2", `${CLAUDE_TOKEN}-login-2`, "work"),
			],
		});

		expect(await resolveClaudeSdkOauthCredentials(registry, "login-2", noEnv)).toEqual({
			ok: true,
			credentials: { accessToken: `${CLAUDE_TOKEN}-login-2` },
		});
	});

	it("never falls back to a sibling account when the named one is unknown", async () => {
		const registry = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });

		const result = await resolveClaudeSdkOauthCredentials(registry, "login-2", noEnv);

		expect(result).toEqual({ ok: false, reason: "oauth-not-configured" });
		expect(JSON.stringify(result)).not.toContain(CLAUDE_TOKEN);
	});

	it("reports oauth-not-configured when the lane has no account at all", async () => {
		expect(await resolveClaudeSdkOauthCredentials(claudeRegistry({}), undefined, noEnv)).toEqual({
			ok: false,
			reason: "oauth-not-configured",
		});
	});

	it("reports token-expired instead of sending a stale token", async () => {
		const registry = claudeRegistry({
			slots: [{ name: "default", access: CLAUDE_TOKEN, expires: Date.now() - 1000 }],
		});

		const result = await resolveClaudeSdkOauthCredentials(registry, undefined, noEnv);

		expect(result).toEqual({ ok: false, reason: "token-expired" });
		expect(JSON.stringify(result)).not.toContain(CLAUDE_TOKEN);
	});

	it("uses an account whose source reports no expiry", async () => {
		const registry = claudeRegistry({
			slots: [{ name: "default", access: CLAUDE_TOKEN, expires: 0 }],
		});

		expect(await resolveClaudeSdkOauthCredentials(registry, undefined, noEnv)).toEqual({
			ok: true,
			credentials: { accessToken: CLAUDE_TOKEN },
		});
	});

	it("prefers a stored account over an environment account of the same name", async () => {
		const registry = claudeRegistry({ slots: [usableSlot("env", `${CLAUDE_TOKEN}-stored`)] });
		const env: EnvReader = (name) =>
			name === "CLAUDE_CODE_OAUTH_TOKEN" ? `${CLAUDE_TOKEN}-env` : undefined;

		expect(await resolveClaudeSdkOauthCredentials(registry, "env", env)).toEqual({
			ok: true,
			credentials: { accessToken: `${CLAUDE_TOKEN}-stored` },
		});
	});

	it("resolves an environment account by name", async () => {
		const env: EnvReader = (name) =>
			name === "CLAUDE_CODE_OAUTH_TOKEN_2" ? `${CLAUDE_TOKEN}-2` : undefined;

		expect(await resolveClaudeSdkOauthCredentials(claudeRegistry({}), "env-2", env)).toEqual({
			ok: true,
			credentials: { accessToken: `${CLAUDE_TOKEN}-2` },
		});
	});

	it("ignores an environment reader that throws", async () => {
		const registry = claudeRegistry({ slots: [usableSlot("default", CLAUDE_TOKEN)] });
		const env: EnvReader = () => {
			throw new Error(`env read failed for ${CLAUDE_TOKEN}`);
		};

		expect(await resolveClaudeSdkOauthCredentials(registry, undefined, env)).toEqual({
			ok: true,
			credentials: { accessToken: CLAUDE_TOKEN },
		});
	});
});

describe("resolveClaudeSdkOauthCredentials refreshing an expired stored token", () => {
	const HOST_ID = "anthropic-subscription";
	const ROTATED: RefreshedTokens = {
		access: `${CLAUDE_TOKEN}-rotated`,
		refresh: `${CLAUDE_TOKEN}-rotated-refresh`,
		expires: Date.now() + HOUR_MS,
	};

	function expiredSlot(name: string): Record<string, unknown> {
		return {
			name,
			access: `${CLAUDE_TOKEN}-${name}`,
			refresh: `${CLAUDE_TOKEN}-${name}-refresh`,
			expires: Date.now() - 1000,
			source: "login",
		};
	}

	/**
	 * Host whose credential store serializes read-modify-write like the real
	 * one: `modify` hands the callback the stored credential, keeps it when the
	 * callback answers undefined, and answers with the credential it now holds.
	 * `listed` is what the cached slot listing reports, which may lag the store.
	 */
	function lockedStore(options: {
		readonly stored: Record<string, unknown>;
		readonly listed?: readonly unknown[];
		readonly modify?: () => never;
	}) {
		let credential = options.stored;
		const registry = fakeRegistry({
			authStorage: {
				listSlots: (provider: string) =>
					provider === HOST_ID ? (options.listed ?? credential["accounts"]) : [],
				modify:
					options.modify ??
					(async (provider: string, fn: (current: unknown) => Promise<unknown>) => {
						expect(provider).toBe(HOST_ID);
						const next = await fn(credential);
						if (next !== undefined) credential = next as Record<string, unknown>;
						return credential;
					}),
				read: async (provider: string) => (provider === HOST_ID ? credential : undefined),
			},
		});
		return { registry, current: () => credential };
	}

	function recordingRefresher(answer: () => Promise<RefreshedTokens>): {
		readonly refresher: TokenRefresher;
		readonly calls: string[];
	} {
		const calls: string[] = [];
		return {
			calls,
			refresher: async (refreshToken) => {
				calls.push(refreshToken);
				return answer();
			},
		};
	}

	it("refreshes the expired account under the lock and writes only that account back", async () => {
		const sibling = usableSlot("login-2", `${CLAUDE_TOKEN}-sibling`);
		const store = lockedStore({
			stored: { type: "oauth", pinned: "default", accounts: [expiredSlot("default"), sibling] },
		});
		const { refresher, calls } = recordingRefresher(async () => ROTATED);

		const result = await resolveClaudeSdkOauthCredentials(store.registry, "default", noEnv, {
			refresher,
		});

		expect(result).toEqual({ ok: true, credentials: { accessToken: ROTATED.access } });
		expect(calls).toEqual([`${CLAUDE_TOKEN}-default-refresh`]);
		expect(store.current()).toEqual({
			type: "oauth",
			pinned: "default",
			accounts: [{ ...expiredSlot("default"), ...ROTATED, expires: ROTATED.expires }, sibling],
		});
	});

	it("leaves a token that is about to expire but still valid to the chat lane", async () => {
		const expiringSoon = { ...expiredSlot("default"), expires: Date.now() + 60_000 };
		const store = lockedStore({ stored: { type: "oauth", accounts: [expiringSoon] } });
		const { refresher, calls } = recordingRefresher(async () => ROTATED);

		const result = await resolveClaudeSdkOauthCredentials(store.registry, undefined, noEnv, {
			refresher,
		});

		expect(result).toEqual({ ok: true, credentials: { accessToken: `${CLAUDE_TOKEN}-default` } });
		expect(calls).toEqual([]);
		expect(store.current()).toEqual({ type: "oauth", accounts: [expiringSoon] });
	});

	it("adopts a token another writer rotated before the lock was taken", async () => {
		const fresh = usableSlot("default", `${CLAUDE_TOKEN}-fresh`);
		const store = lockedStore({
			stored: { type: "oauth", accounts: [fresh] },
			listed: [expiredSlot("default")],
		});
		const { refresher, calls } = recordingRefresher(async () => ROTATED);

		const result = await resolveClaudeSdkOauthCredentials(store.registry, undefined, noEnv, {
			refresher,
		});

		expect(result).toEqual({ ok: true, credentials: { accessToken: `${CLAUDE_TOKEN}-fresh` } });
		expect(calls).toEqual([]);
	});

	it("reports token-refresh-failed and keeps the store when the grant cannot be redeemed", async () => {
		const stored = { type: "oauth", accounts: [expiredSlot("default")] };
		const store = lockedStore({ stored });
		const { refresher } = recordingRefresher(async () => {
			throw new Error(`invalid_grant for ${CLAUDE_TOKEN}`);
		});

		const result = await resolveClaudeSdkOauthCredentials(store.registry, undefined, noEnv, {
			refresher,
		});

		expect(result).toEqual({ ok: false, reason: "token-refresh-failed" });
		expect(JSON.stringify(result)).not.toContain(CLAUDE_TOKEN);
		expect(store.current()).toBe(stored);
	});

	it("adopts the latest stored token when another writer holds the store", async () => {
		const busy = Object.assign(new Error("Credential store is busy"), {
			name: "CredentialStoreBusyError",
		});
		const store = lockedStore({
			stored: { type: "oauth", accounts: [usableSlot("default", `${CLAUDE_TOKEN}-fresh`)] },
			listed: [expiredSlot("default")],
			modify: () => {
				throw busy;
			},
		});
		const { refresher, calls } = recordingRefresher(async () => ROTATED);

		const result = await resolveClaudeSdkOauthCredentials(store.registry, undefined, noEnv, {
			refresher,
		});

		expect(result).toEqual({ ok: true, credentials: { accessToken: `${CLAUDE_TOKEN}-fresh` } });
		expect(calls).toEqual([]);
	});

	it("re-throws the caller's own cancellation during a refresh", async () => {
		const controller = new AbortController();
		const store = lockedStore({ stored: { type: "oauth", accounts: [expiredSlot("default")] } });
		const refresher: TokenRefresher = async () => {
			controller.abort();
			throw controller.signal.reason;
		};

		await expect(
			resolveClaudeSdkOauthCredentials(store.registry, undefined, noEnv, {
				refresher,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

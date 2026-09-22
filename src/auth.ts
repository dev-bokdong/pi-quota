import type { ProviderId, QuotaAccount, UnavailableReason } from "./types.ts";

export interface QuotaAuthModel {
	readonly provider: string;
}

export interface QuotaAuthResolution {
	readonly ok: boolean;
	readonly apiKey?: string;
}

/**
 * The host members this extension reads. `authStorage` and `modelRuntime` carry
 * the credential-pool surface (`listSlots`, slot-scoped `getAuth`); hosts that
 * predate pools do not implement them, so both are probed at runtime and a
 * missing member degrades to the provider's single flat credential.
 */
export interface QuotaModelRegistry {
	getAvailable(): readonly QuotaAuthModel[];
	isUsingOAuth(model: QuotaAuthModel): boolean;
	getApiKeyAndHeaders(model: QuotaAuthModel): Promise<QuotaAuthResolution>;
	readonly authStorage?: unknown;
	readonly modelRuntime?: unknown;
}

export interface OAuthCredentials {
	readonly accessToken: string;
}

export type AuthResolution =
	| { readonly ok: true; readonly credentials: OAuthCredentials }
	| { readonly ok: false; readonly reason: UnavailableReason };

const NOT_CONFIGURED: AuthResolution = { ok: false, reason: "oauth-not-configured" };
const UNSUPPORTED_AUTH: AuthResolution = { ok: false, reason: "unsupported-auth-method" };
const TOKEN_EXPIRED: AuthResolution = { ok: false, reason: "token-expired" };

const CLAUDE_SDK_OAUTH_PROVIDER = "claude-sdk-oauth" as const;

/**
 * The spellings a host may use for one provider, canonical first. senpi
 * 2026.9.22 renamed `openai-codex` to `chatgpt-subscription` and
 * `claude-sdk-oauth` to `anthropic-subscription`; an older host still speaks
 * only the legacy id, so both are tried and the host's own answer decides.
 */
const HOST_PROVIDER_IDS: Readonly<Record<ProviderId, readonly string[]>> = {
	"openai-codex": ["chatgpt-subscription", "openai-codex"],
	anthropic: ["anthropic"],
	"claude-sdk-oauth": ["anthropic-subscription", "claude-sdk-oauth"],
};

/** Host spellings of one provider id, in the order they should be tried. */
export function hostProviderIds(providerId: ProviderId): readonly string[] {
	return HOST_PROVIDER_IDS[providerId];
}

/**
 * Marker the host projects onto the Claude SDK OAuth flat credential in place
 * of a token: the real material lives in each account's credential slot, and
 * the marker itself can never authenticate a request.
 */
const CLAUDE_SDK_OAUTH_SENTINEL = "claude-sdk-oauth-managed";

/**
 * Read-only Claude Code tokens the host accepts from the environment, under the
 * account names it gives them, so an env-configured account is named in the
 * output exactly as `/claude-account` names it.
 */
const ENV_TOKEN_SLOTS: readonly { readonly variable: string; readonly name: string }[] = [
	{ variable: "CLAUDE_CODE_OAUTH_TOKEN", name: "env" },
	...Array.from({ length: 15 }, (_unused, index) => ({
		variable: `CLAUDE_CODE_OAUTH_TOKEN_${index + 2}`,
		name: `env-${index + 2}`,
	})),
];

/** Reads one environment variable; the default reads this process's own. */
export type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) => process.env[name];

type HostCall = (...args: readonly unknown[]) => unknown;

export function readProperty(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Binds one host method, or reports its absence on an older host. */
export function hostCall(host: unknown, name: string): HostCall | undefined {
	const value = readProperty(host, name);
	return typeof value === "function" ? (value.bind(host) as HostCall) : undefined;
}

function toAccount(slot: unknown): QuotaAccount | undefined {
	const name = readProperty(slot, "name");
	if (typeof name !== "string" || name.length === 0) return undefined;
	const displayName = readProperty(slot, "displayName");
	return {
		name,
		label: typeof displayName === "string" && displayName.length > 0 ? displayName : name,
	};
}

/**
 * Lists the provider's credential accounts. A provider with at most one account
 * resolves to an empty list, which keeps it on the flat-credential path and
 * leaves its output unlabelled — the same answer a host without credential
 * pools gives.
 */
export function listQuotaAccounts(
	registry: QuotaModelRegistry,
	providerId: ProviderId,
	includeSingle = false,
): readonly QuotaAccount[] {
	const accounts: QuotaAccount[] = [];
	for (const slot of storedSlots(registry, providerId)) {
		const account = toAccount(slot);
		if (account) accounts.push(account);
	}
	return includeSingle || accounts.length > 1 ? accounts : [];
}

/** Reads the provider's stored credential slots on a host that pools them. */
function storedSlots(registry: QuotaModelRegistry, providerId: ProviderId): readonly unknown[] {
	const listSlots = hostCall(registry.authStorage, "listSlots");
	if (!listSlots) return [];

	for (const hostId of hostProviderIds(providerId)) {
		let slots: unknown;
		try {
			slots = listSlots(hostId);
		} catch {
			return [];
		}
		if (Array.isArray(slots) && slots.length > 0) return slots;
	}
	return [];
}

/** One Claude SDK OAuth account together with the token stored for it. */
interface ClaudeSdkOauthSlot {
	readonly account: QuotaAccount;
	readonly accessToken: string;
	/** Epoch milliseconds, absent when the account's source reports no expiry. */
	readonly expiresAt?: number;
}

function toClaudeSdkOauthSlot(slot: unknown): ClaudeSdkOauthSlot | undefined {
	const account = toAccount(slot);
	if (!account) return undefined;

	const access = readProperty(slot, "access");
	if (typeof access !== "string" || access.length === 0 || access === CLAUDE_SDK_OAUTH_SENTINEL) {
		return undefined;
	}

	const expires = readProperty(slot, "expires");
	return typeof expires === "number" && Number.isFinite(expires) && expires > 0
		? { account, accessToken: access, expiresAt: expires }
		: { account, accessToken: access };
}

/**
 * Collects the Claude SDK OAuth accounts that hold a usable token: the stored
 * credential slots first, then the environment tokens the host also accepts. A
 * stored account wins over an environment account of the same name, which is
 * the precedence the host's own account listing applies.
 */
function claudeSdkOauthSlots(
	registry: QuotaModelRegistry,
	env: EnvReader,
): readonly ClaudeSdkOauthSlot[] {
	const slots: ClaudeSdkOauthSlot[] = [];
	for (const raw of storedSlots(registry, CLAUDE_SDK_OAUTH_PROVIDER)) {
		const slot = toClaudeSdkOauthSlot(raw);
		if (slot && !slots.some((existing) => existing.account.name === slot.account.name)) {
			slots.push(slot);
		}
	}

	for (const { variable, name } of ENV_TOKEN_SLOTS) {
		let token: unknown;
		try {
			token = env(variable);
		} catch {
			continue;
		}
		if (typeof token !== "string" || token.length === 0) continue;
		if (slots.some((existing) => existing.account.name === name)) continue;
		slots.push({ account: { name, label: name }, accessToken: token });
	}

	return slots;
}

/**
 * Lists every Claude SDK OAuth account that holds a readable token, including
 * the only one when the lane has just one. An empty list means the lane is not
 * configured at all, which is what keeps this opt-in provider out of the
 * output of a session that never signed into it.
 */
export function listClaudeSdkOauthAccounts(
	registry: QuotaModelRegistry,
	env: EnvReader = processEnv,
): readonly QuotaAccount[] {
	return claudeSdkOauthSlots(registry, env).map((slot) => slot.account);
}

/**
 * Reads one Claude SDK OAuth account's access token, or the only account's when
 * no name is given. The host resolves this provider's auth to a managed marker
 * rather than a token — the SDK subprocess owns the request, not senpi — so the
 * token is read from the account's own credential slot instead.
 *
 * An expired stored token is reported as such rather than sent: only the lane
 * that owns the credential may refresh it, and a rotated refresh token written
 * by anyone else would invalidate the account.
 */
export function resolveClaudeSdkOauthCredentials(
	registry: QuotaModelRegistry,
	accountName?: string,
	env: EnvReader = processEnv,
): AuthResolution {
	const slots = claudeSdkOauthSlots(registry, env);
	const slot =
		accountName === undefined
			? slots[0]
			: slots.find((candidate) => candidate.account.name === accountName);
	if (!slot) return NOT_CONFIGURED;
	if (slot.expiresAt !== undefined && slot.expiresAt <= Date.now()) return TOKEN_EXPIRED;
	return { ok: true, credentials: { accessToken: slot.accessToken } };
}

async function flatAccessToken(
	registry: QuotaModelRegistry,
	model: QuotaAuthModel,
): Promise<string | undefined> {
	const resolved = await registry.getApiKeyAndHeaders(model);
	return resolved.ok && resolved.apiKey ? resolved.apiKey : undefined;
}

/**
 * Resolves one named account's access token through the host's slot-scoped
 * auth, which refreshes that account's own token and never falls back to
 * another account: a miss therefore belongs to this account alone and cannot
 * report a sibling's quota under this account's label.
 */
async function accountAccessToken(
	registry: QuotaModelRegistry,
	model: QuotaAuthModel,
	providerId: ProviderId,
	accountName: string,
): Promise<string | undefined> {
	const getAuth = hostCall(registry.modelRuntime, "getAuth");
	if (!getAuth) {
		// A host that pools credentials without slot-scoped auth can only speak for
		// its single account; with several, the flat credential could answer under
		// the wrong account's label.
		const accounts = listQuotaAccounts(registry, providerId, true);
		return accounts.length === 1 && accounts[0]?.name === accountName
			? await flatAccessToken(registry, model)
			: undefined;
	}
	// The host answers under its own spelling of the provider, which is the one
	// its model carries.
	const resolved = await getAuth(model.provider, { slotName: accountName });
	const apiKey = readProperty(readProperty(resolved, "auth"), "apiKey");
	return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
}

/**
 * Reads the provider's OAuth access token, for one named credential account
 * when `accountName` is given and for the flat credential otherwise.
 */
export async function resolveOAuthCredentials(
	registry: QuotaModelRegistry,
	providerId: ProviderId,
	accountName?: string,
): Promise<AuthResolution> {
	const hostIds = hostProviderIds(providerId);
	const model = registry.getAvailable().find((candidate) => hostIds.includes(candidate.provider));
	if (!model) {
		return NOT_CONFIGURED;
	}
	if (!registry.isUsingOAuth(model)) {
		return UNSUPPORTED_AUTH;
	}
	try {
		const accessToken =
			accountName === undefined
				? await flatAccessToken(registry, model)
				: await accountAccessToken(registry, model, providerId, accountName);
		if (accessToken === undefined) {
			return NOT_CONFIGURED;
		}
		return { ok: true, credentials: { accessToken } };
	} catch {
		return NOT_CONFIGURED;
	}
}

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

type HostCall = (...args: readonly unknown[]) => unknown;

function readProperty(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Binds one host method, or reports its absence on an older host. */
function hostCall(host: unknown, name: string): HostCall | undefined {
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
): readonly QuotaAccount[] {
	const listSlots = hostCall(registry.authStorage, "listSlots");
	if (!listSlots) return [];

	let slots: unknown;
	try {
		slots = listSlots(providerId);
	} catch {
		return [];
	}
	if (!Array.isArray(slots)) return [];

	const accounts: QuotaAccount[] = [];
	for (const slot of slots) {
		const account = toAccount(slot);
		if (account) accounts.push(account);
	}
	return accounts.length > 1 ? accounts : [];
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
	providerId: ProviderId,
	accountName: string,
): Promise<string | undefined> {
	const getAuth = hostCall(registry.modelRuntime, "getAuth");
	if (!getAuth) return undefined;
	const resolved = await getAuth(providerId, { slotName: accountName });
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
	const model = registry.getAvailable().find((candidate) => candidate.provider === providerId);
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
				: await accountAccessToken(registry, providerId, accountName);
		if (accessToken === undefined) {
			return NOT_CONFIGURED;
		}
		return { ok: true, credentials: { accessToken } };
	} catch {
		return NOT_CONFIGURED;
	}
}

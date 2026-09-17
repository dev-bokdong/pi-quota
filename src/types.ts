export type ProviderId = "openai-codex" | "anthropic" | "claude-sdk-oauth";

/** One credential account of a provider that pools more than one. */
export interface QuotaAccount {
	/** Immutable slot identity used to resolve this account's credential. */
	readonly name: string;
	/** Label shown in the output: the account's display name when it has one. */
	readonly label: string;
}

/**
 * Account label carried by a provider result. It is absent for a provider read
 * through its flat credential, which keeps single-account output unlabelled.
 */
export type AccountFields = { readonly account?: string };

export function accountFields(account: QuotaAccount | undefined): AccountFields {
	return account === undefined ? {} : { account: account.label };
}

export interface QuotaWindow {
	readonly label: string;
	readonly remainingPercent: number;
	readonly resetAt?: Date;
}

export interface ProviderSuccess {
	readonly kind: "success";
	readonly provider: ProviderId;
	readonly displayName: string;
	readonly windows: readonly QuotaWindow[];
	readonly account?: string;
}

export type UnavailableReason =
	| "oauth-not-configured"
	| "unsupported-auth-method"
	| "token-expired"
	| "no-quota-windows";

export interface ProviderUnavailable {
	readonly kind: "unavailable";
	readonly provider: ProviderId;
	readonly reason: UnavailableReason;
	readonly account?: string;
}

export type ProviderFailureReason =
	| { readonly type: "http-error"; readonly status: number }
	| { readonly type: "network-error" }
	| { readonly type: "timeout" }
	| { readonly type: "invalid-response" };

export interface ProviderFailure {
	readonly kind: "failure";
	readonly provider: ProviderId;
	readonly reason: ProviderFailureReason;
	readonly retryAfterSeconds?: number;
	readonly account?: string;
}

export type ProviderResult = ProviderSuccess | ProviderUnavailable | ProviderFailure;

export function clampPercent(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.round(Math.min(100, Math.max(0, value)));
}

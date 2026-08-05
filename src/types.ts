export type ProviderId = "openai-codex" | "anthropic";

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
}

export type UnavailableReason =
	| "oauth-not-configured"
	| "unsupported-auth-method"
	| "no-quota-windows";

export interface ProviderUnavailable {
	readonly kind: "unavailable";
	readonly provider: ProviderId;
	readonly reason: UnavailableReason;
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
}

export type ProviderResult = ProviderSuccess | ProviderUnavailable | ProviderFailure;

export function clampPercent(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.round(Math.min(100, Math.max(0, value)));
}

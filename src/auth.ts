import type { ProviderId, UnavailableReason } from "./types.ts";

export interface QuotaAuthModel {
	readonly provider: string;
}

export interface QuotaAuthResolution {
	readonly ok: boolean;
	readonly apiKey?: string;
}

export interface QuotaModelRegistry {
	getAvailable(): readonly QuotaAuthModel[];
	isUsingOAuth(model: QuotaAuthModel): boolean;
	getApiKeyAndHeaders(model: QuotaAuthModel): Promise<QuotaAuthResolution>;
}

export interface OAuthCredentials {
	readonly accessToken: string;
}

export type AuthResolution =
	| { readonly ok: true; readonly credentials: OAuthCredentials }
	| { readonly ok: false; readonly reason: UnavailableReason };

const NOT_CONFIGURED: AuthResolution = { ok: false, reason: "oauth-not-configured" };
const UNSUPPORTED_AUTH: AuthResolution = { ok: false, reason: "unsupported-auth-method" };

export async function resolveOAuthCredentials(
	registry: QuotaModelRegistry,
	providerId: ProviderId,
): Promise<AuthResolution> {
	const model = registry.getAvailable().find((candidate) => candidate.provider === providerId);
	if (!model) {
		return NOT_CONFIGURED;
	}
	if (!registry.isUsingOAuth(model)) {
		return UNSUPPORTED_AUTH;
	}
	try {
		const resolved = await registry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.apiKey) {
			return NOT_CONFIGURED;
		}
		return { ok: true, credentials: { accessToken: resolved.apiKey } };
	} catch {
		return NOT_CONFIGURED;
	}
}

import type { EnvReader, QuotaModelRegistry } from "../auth.ts";
import { resolveClaudeSdkOauthCredentials } from "../auth.ts";
import type { FetchLike } from "../http.ts";
import type { ProviderResult, QuotaAccount } from "../types.ts";
import { accountFields } from "../types.ts";
import { fetchAnthropicUsage } from "./anthropic-usage.ts";

const PROVIDER_ID = "claude-sdk-oauth" as const;
const DISPLAY_NAME = "Claude SDK";

export interface ClaudeSdkOauthQuotaOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetch?: FetchLike;
	/** Reads this Claude SDK OAuth account instead of the only account. */
	readonly account?: QuotaAccount;
	/** Reads the environment-provided accounts; defaults to this process's env. */
	readonly env?: EnvReader;
}

/**
 * Reads the Claude Pro/Max subscription quota of one Claude SDK OAuth account,
 * which is the same subscription surface the Claude Code engine spends. Never
 * throws except to propagate the caller's own cancellation; every other outcome
 * is a ProviderResult.
 */
export async function fetchClaudeSdkOauthQuota(
	registry: QuotaModelRegistry,
	options: ClaudeSdkOauthQuotaOptions = {},
): Promise<ProviderResult> {
	const account = accountFields(options.account);
	const auth = resolveClaudeSdkOauthCredentials(registry, options.account?.name, options.env);
	if (!auth.ok) {
		return { kind: "unavailable", provider: PROVIDER_ID, reason: auth.reason, ...account };
	}

	return fetchAnthropicUsage({
		provider: PROVIDER_ID,
		displayName: DISPLAY_NAME,
		accessToken: auth.credentials.accessToken,
		account,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
}

import type { ExtensionAPI, ExtensionCommandContext } from "@code-yeongyu/senpi";
import type { QuotaModelRegistry } from "./auth.ts";
import { listClaudeSdkOauthAccounts, listQuotaAccounts } from "./auth.ts";
import { formatQuotaResults, notifySeverityForResults, whiteText } from "./format.ts";
import { fetchAnthropicQuota } from "./providers/anthropic.ts";
import { fetchClaudeSdkOauthQuota } from "./providers/claude-sdk-oauth.ts";
import { fetchOpenAiQuota } from "./providers/openai.ts";
import type { AccountFields, ProviderId, ProviderResult, QuotaAccount } from "./types.ts";
import { accountFields } from "./types.ts";

const STATUS_KEY = "pi-quota";
const LOADING_STATUS = "Loading quota...";
const USAGE_MESSAGE = "/quota takes no arguments. Run /quota on its own to read your quota.";
const SCOPE_MESSAGE = "/quota is available in interactive mode only. No quota request was made.";
const COMMAND_DESCRIPTION = "Show OpenAI Codex, Anthropic and Claude SDK subscription quota";

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Guards one provider lookup. The adapters are contracted to resolve for every
 * outcome except the caller's own cancellation, so an unexpected throw is
 * downgraded to a failure result rather than being allowed to hide the other
 * provider's answer or crash the command.
 */
function guarded(
	pending: Promise<ProviderResult>,
	provider: ProviderId,
	account: AccountFields,
): Promise<ProviderResult> {
	return pending.catch((error: unknown): ProviderResult => {
		if (isAbortError(error)) throw error;
		return { kind: "failure", provider, reason: { type: "invalid-response" }, ...account };
	});
}

interface QuotaLookupOptions {
	readonly signal: AbortSignal;
	readonly account?: QuotaAccount;
}

/**
 * One lookup per credential account of a provider that pools several, so each
 * account reports its own limits and one account's failure never hides the
 * others. A provider with at most one account keeps the single, unlabelled
 * lookup.
 */
function providerLookups(
	provider: ProviderId,
	accounts: readonly QuotaAccount[],
	fetchQuota: (options: QuotaLookupOptions) => Promise<ProviderResult>,
	signal: AbortSignal,
): readonly Promise<ProviderResult>[] {
	if (accounts.length < 2) {
		return [guarded(fetchQuota({ signal }), provider, {})];
	}
	return accounts.map((account) =>
		guarded(fetchQuota({ signal, account }), provider, accountFields(account)),
	);
}

/**
 * Claude SDK OAuth is an opt-in lane with its own accounts, so a session that
 * never signed into it is not told the lane is missing - the lane is simply not
 * part of the answer.
 */
function claudeSdkOauthLookups(
	registry: QuotaModelRegistry,
	signal: AbortSignal,
): readonly Promise<ProviderResult>[] {
	const accounts = listClaudeSdkOauthAccounts(registry);
	if (accounts.length === 0) return [];
	return providerLookups(
		"claude-sdk-oauth",
		accounts,
		(options) => fetchClaudeSdkOauthQuota(registry, options),
		signal,
	);
}

export default function(pi: ExtensionAPI): void {
	let currentController: AbortController | undefined;

	pi.registerCommand("quota", {
		description: COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (args.trim().length > 0) {
				ctx.ui.notify(USAGE_MESSAGE, "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(SCOPE_MESSAGE, "info");
				return;
			}

			// A newer invocation supersedes any still-running one.
			currentController?.abort();
			const controller = new AbortController();
			currentController = controller;

			ctx.ui.setStatus(STATUS_KEY, LOADING_STATUS);
			try {
				const registry = ctx.modelRegistry;
				const results = await Promise.all([
					...providerLookups(
						"openai-codex",
						listQuotaAccounts(registry, "openai-codex"),
						(options) => fetchOpenAiQuota(registry, options),
						controller.signal,
					),
					...providerLookups(
						"anthropic",
						listQuotaAccounts(registry, "anthropic"),
						(options) => fetchAnthropicQuota(registry, options),
						controller.signal,
					),
					...claudeSdkOauthLookups(registry, controller.signal),
				]);
				if (currentController !== controller) return;
				// A provider holding no OAuth is not part of the answer, so an
				// invocation that could read nothing has nothing to say and stays
				// silent instead of reporting a sign-in the session never made.
				const block = formatQuotaResults(results);
				if (block !== "") {
					ctx.ui.notify(whiteText(block), notifySeverityForResults(results));
				}
			} catch {
				// Only this invocation's own cancellation reaches here, which means a
				// newer invocation or the session shutdown owns the UI now.
			} finally {
				if (currentController === controller) {
					ctx.ui.setStatus(STATUS_KEY, undefined);
					currentController = undefined;
				}
			}
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentController?.abort();
		currentController = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

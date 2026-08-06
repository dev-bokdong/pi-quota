import type { ExtensionAPI, ExtensionCommandContext } from "@code-yeongyu/senpi";
import { formatQuotaResults, notifySeverityForResults } from "./format.ts";
import { fetchAnthropicQuota } from "./providers/anthropic.ts";
import { fetchOpenAiQuota } from "./providers/openai.ts";
import type { ProviderId, ProviderResult } from "./types.ts";

const STATUS_KEY = "pi-quota";
const LOADING_STATUS = "Loading quota...";
const USAGE_MESSAGE = "/quota takes no arguments. Run /quota on its own to read your quota.";
const SCOPE_MESSAGE =
	"/quota is available on Linux in interactive mode only. No quota request was made.";
const COMMAND_DESCRIPTION = "Show OpenAI Codex and Anthropic subscription quota";

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Guards one provider lookup. The adapters are contracted to resolve for every
 * outcome except the caller's own cancellation, so an unexpected throw is
 * downgraded to a failure result rather than being allowed to hide the other
 * provider's answer or crash the command.
 */
function guarded(pending: Promise<ProviderResult>, provider: ProviderId): Promise<ProviderResult> {
	return pending.catch((error: unknown): ProviderResult => {
		if (isAbortError(error)) throw error;
		return { kind: "failure", provider, reason: { type: "invalid-response" } };
	});
}

export default function (pi: ExtensionAPI): void {
	let currentController: AbortController | undefined;

	pi.registerCommand("quota", {
		description: COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (args.trim().length > 0) {
				ctx.ui.notify(USAGE_MESSAGE, "info");
				return;
			}
			if (process.platform !== "linux" || !ctx.hasUI) {
				ctx.ui.notify(SCOPE_MESSAGE, "info");
				return;
			}

			// A newer invocation supersedes any still-running one.
			currentController?.abort();
			const controller = new AbortController();
			currentController = controller;

			ctx.ui.setStatus(STATUS_KEY, LOADING_STATUS);
			try {
				const [openai, anthropic] = await Promise.all([
					guarded(
						fetchOpenAiQuota(ctx.modelRegistry, { signal: controller.signal }),
						"openai-codex",
					),
					guarded(
						fetchAnthropicQuota(ctx.modelRegistry, { signal: controller.signal }),
						"anthropic",
					),
				]);
				if (currentController !== controller) return;
				const results = [openai, anthropic];
				ctx.ui.notify(formatQuotaResults(results), notifySeverityForResults(results));
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

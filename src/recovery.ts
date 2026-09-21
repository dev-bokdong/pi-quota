import { hostCall, type QuotaModelRegistry, readProperty } from "./auth.ts";
import type { ProviderId, ProviderResult, QuotaAccount } from "./types.ts";

type RecordValue = Record<string, unknown>;
export type QuotaRecovery = (result: ProviderResult, signal: AbortSignal) => Promise<void>;

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as RecordValue)
		: undefined;
}

function storedSlot(credential: unknown, name: string): RecordValue | undefined {
	const accounts = readProperty(credential, "accounts");
	if (Array.isArray(accounts)) {
		return record(accounts.find((slot: unknown) => readProperty(slot, "name") === name));
	}
	// The host projects a legacy flat credential as the default slot.
	return name === "default" ? record(credential) : undefined;
}

function permanent(block: unknown): boolean {
	const reason = readProperty(block, "blockReason");
	return reason === "auth_error" || reason === "account_disabled";
}

function sameMaterial(left: unknown, right: unknown): boolean {
	return ["access", "refresh", "key", "expires"].every(
		(key) => readProperty(left, key) === readProperty(right, key),
	);
}

function sameBlock(left: unknown, right: unknown): boolean {
	return ["blockReason", "blockedUntil"].every(
		(key) => readProperty(left, key) === readProperty(right, key),
	);
}

function clearRateLimit(value: RecordValue): RecordValue {
	if (readProperty(value, "blockReason") !== "rate_limit") return value;
	const { blockReason: _reason, blockedUntil: _until, ...rest } = value;
	return rest;
}

/**
 * Snapshot before the HTTP request, then compare under the host's locks.
 * loadCredentialPool is an optional runtime capability (not a public import);
 * without it we cannot rule out a permanent sidecar block, so stay read-only.
 */
export async function prepareQuotaRecovery(
	registry: QuotaModelRegistry,
	provider: ProviderId,
	account: QuotaAccount | undefined,
): Promise<QuotaRecovery | undefined> {
	if (!account) return undefined;
	const read = hostCall(registry.authStorage, "read");
	const modify = hostCall(registry.authStorage, "modify");
	const loadPool = hostCall(registry.modelRuntime, "loadCredentialPool");
	if (!read || !modify || !loadPool) return undefined;
	const pool = await loadPool();
	const repository = readProperty(pool, "repository");
	const list = hostCall(repository, "listSlots");
	const mutate = hostCall(repository, "mutateSlotState");
	if (!list || !mutate) return undefined;
	const credential = await read(provider);
	const slot = storedSlot(credential, account.name);
	const envName =
		account.name === "env"
			? "CLAUDE_CODE_OAUTH_TOKEN"
			: /^env-(?:[2-9]|1[0-6])$/.test(account.name)
				? `CLAUDE_CODE_OAUTH_TOKEN_${account.name.slice(4)}`
				: undefined;
	const envToken =
		!slot && provider === "claude-sdk-oauth" && envName ? process.env[envName] : undefined;
	if (!slot && !envToken) return undefined;
	const lane = slot ? "stored" : "env";
	const block = slot ?? record(readProperty(readProperty(credential, "slotState"), account.name));
	const state = record(readProperty(await list(provider, lane), account.name));
	if (permanent(block) || permanent(state)) return undefined;
	if (
		readProperty(block, "blockReason") !== "rate_limit" &&
		readProperty(state, "blockReason") !== "rate_limit"
	) {
		return undefined;
	}
	const revisionMethod = hostCall(
		repository,
		slot ? "storedCredentialRevision" : "envCredentialRevision",
	);
	if (!revisionMethod) return undefined;
	const revision = slot
		? await revisionMethod(provider, account.name, slot)
		: await revisionMethod(envName, envToken);
	// A stale sidecar belongs to different credentials and must not be rewritten.
	if (state && readProperty(state, "credentialRevision") !== revision) return undefined;

	return async (result, signal) => {
		if (signal.aborted || result.kind !== "success") return;
		if (
			!["Five-hour", "Weekly"].every((label) =>
				result.windows.some((window) => window.label === label && window.remainingPercent > 0),
			)
		)
			return;
		await modify(
			provider,
			async (current: unknown) => {
				if (signal.aborted) return current;
				const currentSlot = storedSlot(current, account.name);
				if (
					slot
						? !currentSlot || !sameMaterial(slot, currentSlot)
						: currentSlot || !envName || process.env[envName] !== envToken
				)
					return current;
				const currentBlock =
					currentSlot ?? record(readProperty(readProperty(current, "slotState"), account.name));
				if (!sameBlock(block, currentBlock) || permanent(currentBlock)) return current;
				let matched = false;
				await mutate(provider, lane, account.name, (latest: unknown) => {
					const latestState = record(latest);
					if (
						signal.aborted ||
						permanent(latestState) ||
						readProperty(latestState, "stateVersion") !== readProperty(state, "stateVersion") ||
						readProperty(latestState, "credentialRevision") !==
							readProperty(state, "credentialRevision")
					)
						return latest;
					matched = true;
					if (!latestState || readProperty(latestState, "blockReason") !== "rate_limit")
						return latest;
					const { lease: _lease, ...cleared } = clearRateLimit(latestState);
					return cleared;
				});
				if (
					!matched ||
					signal.aborted ||
					!currentBlock ||
					readProperty(currentBlock, "blockReason") !== "rate_limit"
				) {
					return current;
				}
				const currentRecord = record(current);
				if (!currentRecord) return current;
				if (!slot) {
					return {
						...currentRecord,
						slotState: {
							...record(readProperty(currentRecord, "slotState")),
							[account.name]: clearRateLimit(currentBlock),
						},
					};
				}
				const accounts = readProperty(currentRecord, "accounts");
				return Array.isArray(accounts)
					? {
							...currentRecord,
							accounts: accounts.map((entry: unknown) =>
								readProperty(entry, "name") === account.name ? clearRateLimit(currentBlock) : entry,
							),
						}
					: clearRateLimit(currentRecord);
			},
			{ signal },
		);
	};
}

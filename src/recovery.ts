import { hostCall, type QuotaModelRegistry, readProperty } from "./auth.ts";
import type { ProviderId, ProviderResult, QuotaAccount, QuotaWindow } from "./types.ts";
import { clampPercent } from "./types.ts";

type RecordValue = Record<string, unknown>;
/**
 * Reconciles one account's recorded block with the quota just read and resolves
 * to whether the host still refuses that account afterwards.
 */
export type QuotaRecovery = (result: ProviderResult, signal: AbortSignal) => Promise<boolean>;

/** The windows that decide whether the account can serve a request right now. */
const GATING_WINDOWS = ["Five-hour", "Weekly"] as const;
/** The host's own ceiling for a rate-limit cooldown. */
const MAX_BLOCK_MS = 172_800_000;
/** The host's own cooldown for a rate limit whose reset time is unknown. */
const DEFAULT_BLOCK_MS = 60_000;

/** What the quota says should happen to the block recorded for the account. */
type Reconciliation =
	| { readonly kind: "clear" }
	| { readonly kind: "block"; readonly until: number };

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

function rateLimited(block: unknown): boolean {
	return readProperty(block, "blockReason") === "rate_limit";
}

/** The host's own reading of a recorded block: a lapsed cooldown blocks nobody. */
function isBlocked(block: unknown, now: number): boolean {
	if (permanent(block)) return true;
	const until = readProperty(block, "blockedUntil");
	return typeof until === "number" && until > now;
}

/**
 * Reads the block the quota implies. A gating window reported as spent holds the
 * account until it resets, quota left in every gating window releases it, and an
 * answer that shows neither - a missing window - says nothing either way. The
 * percentages are read exactly as the output rounds them, so the block always
 * agrees with the numbers the user is shown.
 */
function reconciliationFor(result: ProviderResult, now: number): Reconciliation | undefined {
	if (result.kind !== "success") return undefined;
	const gating = GATING_WINDOWS.map((label) =>
		result.windows.find((window) => window.label === label),
	);
	const spent = gating.filter(
		(window): window is QuotaWindow =>
			window !== undefined && clampPercent(window.remainingPercent) <= 0,
	);
	if (spent.length === 0) {
		return gating.every((window) => window !== undefined) ? { kind: "clear" } : undefined;
	}
	const resets = spent
		.map((window) => window.resetAt?.getTime())
		.filter((reset): reset is number => reset !== undefined && reset > now);
	const until = resets.length === 0 ? now + DEFAULT_BLOCK_MS : Math.max(...resets);
	return { kind: "block", until: Math.min(until, now + MAX_BLOCK_MS) };
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

function withRateLimit(value: RecordValue, until: number): RecordValue {
	return { ...value, blockReason: "rate_limit", blockedUntil: until };
}

/**
 * Snapshot before the HTTP request, then compare under the host's locks.
 * loadCredentialPool is an optional runtime capability (not a public import);
 * without it we cannot rule out a permanent sidecar block, so stay read-only
 * and say nothing about whether the account is blocked.
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
	// Only a re-login retires a permanent block, so it is reported, never rewritten.
	if (permanent(block) || permanent(state)) return async () => true;
	const report: QuotaRecovery = async () => {
		const now = Date.now();
		return isBlocked(block, now) || isBlocked(state, now);
	};
	const revisionMethod = hostCall(
		repository,
		slot ? "storedCredentialRevision" : "envCredentialRevision",
	);
	if (!revisionMethod) return report;
	const revision = slot
		? await revisionMethod(provider, account.name, slot)
		: await revisionMethod(envName, envToken);
	// A stale sidecar belongs to different credentials and must not be rewritten.
	if (state && readProperty(state, "credentialRevision") !== revision) return report;

	return async (result, signal) => {
		const now = Date.now();
		const wasBlocked = isBlocked(block, now) || isBlocked(state, now);
		if (signal.aborted) return wasBlocked;
		const intent = reconciliationFor(result, now);
		if (!intent) return wasBlocked;
		// An account the host already refuses needs no second block, and one that
		// carries no rate-limit block has nothing to release.
		if (intent.kind === "block" && wasBlocked) return true;
		if (intent.kind === "clear" && !rateLimited(block) && !rateLimited(state)) return false;
		// Set by whichever of the two records the reconciliation actually rewrote:
		// a block recorded in only one of them is still reconciled by that one write.
		let reconciled = false;
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
					// The host owns the shape of a sidecar entry, so one is never invented here.
					if (!latestState) return latest;
					if (intent.kind === "block") {
						const { lease: _lease, ...held } = latestState;
						reconciled = true;
						return withRateLimit(held, intent.until);
					}
					if (!rateLimited(latestState)) return latest;
					const { lease: _lease, ...cleared } = clearRateLimit(latestState);
					reconciled = true;
					return cleared;
				});
				if (!matched || signal.aborted) return current;
				const nextBlock =
					intent.kind === "block"
						? withRateLimit(currentBlock ?? {}, intent.until)
						: currentBlock && rateLimited(currentBlock)
							? clearRateLimit(currentBlock)
							: undefined;
				const currentRecord = record(current);
				if (!nextBlock || !currentRecord) return current;
				reconciled = true;
				if (!slot) {
					return {
						...currentRecord,
						slotState: {
							...record(readProperty(currentRecord, "slotState")),
							[account.name]: nextBlock,
						},
					};
				}
				const accounts = readProperty(currentRecord, "accounts");
				return Array.isArray(accounts)
					? {
							...currentRecord,
							accounts: accounts.map((entry: unknown) =>
								readProperty(entry, "name") === account.name ? nextBlock : entry,
							),
						}
					: nextBlock;
			},
			{ signal },
		);
		return intent.kind === "block" ? reconciled : !reconciled && wasBlocked;
	};
}

import type { ExtensionAPI, ExtensionCommandContext } from "@code-yeongyu/senpi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerQuota from "../src/index.ts";

type Value = Record<string, unknown>;
const PROVIDER = "claude-sdk-oauth";

/** Reads one field of a loosely typed host record without a literal index. */
function prop(value: Value | undefined, key: string): unknown {
	return value === undefined ? undefined : value[key];
}
const TOKEN = "recovery-test-token";

const UNBLOCKED: Value = {};

function blockedNow(): Value {
	return { blockReason: "rate_limit", blockedUntil: Date.now() + 60_000 };
}

/** The host's revision for an env slot differs from a stored one's. */
function revisionFor(name: string): string {
	return name === "env" || name.startsWith("env-") ? "env-revision" : "stored-revision";
}

/**
 * `block` is the block both places start with; `UNBLOCKED` starts them clean.
 * `sidecar: false` leaves the credential pool without an entry for the account,
 * the shape a provider whose pool lane was never written carries.
 */
function fixture(
	names = ["one"],
	block: Value = blockedNow(),
	sidecar = true,
	/** The spelling this host keys the provider's own records by. */
	hostKey: string = PROVIDER,
) {
	let credential: Value = {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		accounts: names.map((name) => ({
			name,
			displayName: "same label",
			access: `${TOKEN}-${name}`,
			refresh: "refresh",
			...block,
		})),
	};
	const states = new Map<string, Value>();
	if (sidecar)
		for (const name of names)
			states.set(name, {
				stateVersion: 1,
				credentialRevision: revisionFor(name),
				failureCount: 2,
				...block,
			});
	const notices: string[] = [];
	/** Every provider id the host was asked to write under. */
	const written: string[] = [];
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let shutdown: (() => void) | undefined;
	const repository = {
		listSlots: async () => Object.fromEntries(states),
		storedCredentialRevision: async () => "stored-revision",
		envCredentialRevision: async () => "env-revision",
		mutateSlotState: async (
			provider: string,
			_lane: string,
			name: string,
			fn: (current: Value | undefined) => Value | undefined,
		) => {
			written.push(provider);
			// The host owns stateVersion: it counts the entry's own revisions, so a
			// created entry starts at 1 whatever the callback returned.
			const current = states.get(name);
			const next = fn(current);
			if (next)
				states.set(name, {
					...next,
					stateVersion: Number(prop(current, "stateVersion") ?? 0) + 1,
				});
			else states.delete(name);
		},
	};
	const storage = {
		listSlots: (provider: string) => (provider === hostKey ? prop(credential, "accounts") : []),
		read: async (provider: string) =>
			provider === hostKey ? structuredClone(credential) : undefined,
		modify: async (provider: string, fn: (current: Value) => Promise<Value>) => {
			written.push(provider);
			credential = await fn(credential);
		},
	};
	const registry = {
		getAvailable: () => [],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: false }),
		authStorage: storage,
		modelRuntime: { loadCredentialPool: async () => ({ repository }) },
	};
	registerQuota({
		registerCommand: (_name: string, options: { handler: typeof command }) => {
			command = options.handler;
		},
		on: (_event: string, handler: (event: unknown, context: ExtensionCommandContext) => void) => {
			shutdown = () => handler({}, ctx);
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI: true,
		modelRegistry: registry,
		ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
	} as unknown as ExtensionCommandContext;
	return {
		states,
		storage,
		registry,
		notices,
		written,
		get credential() {
			return credential;
		},
		set credential(next: Value) {
			credential = next;
		},
		run: async () => {
			if (!command) throw new Error("missing command");
			await command("", ctx);
		},
		cancel: () => shutdown?.(),
	};
}

function respond(
	payload: unknown = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } },
) {
	vi.stubGlobal("fetch", async () => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => payload,
	}));
}

beforeEach(() => {
	for (let i = 1; i <= 16; i++)
		vi.stubEnv(`CLAUDE_CODE_OAUTH_TOKEN${i === 1 ? "" : `_${i}`}`, undefined);
	respond();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("quota-backed recovery", () => {
	it("clears both stored blocks for a single account without changing credentials or its header", async () => {
		const f = fixture();
		await f.run();
		expect(prop(f.credential, "accounts")).toEqual([
			{
				name: "one",
				displayName: "same label",
				access: `${TOKEN}-one`,
				refresh: "refresh",
			},
		]);
		expect(prop(f.states.get("one"), "blockReason")).toBeUndefined();
		expect(prop(f.states.get("one"), "blockedUntil")).toBeUndefined();
		expect(f.notices.join("")).toContain("[Claude SDK]");
		expect(f.notices.join("")).not.toContain("blocked");
		expect(f.notices.join("")).not.toContain(TOKEN);
	});

	it("writes only under the provider id this host keys its records by", async () => {
		const f = fixture();
		await f.run();
		expect([...new Set(f.written)]).toEqual([PROVIDER]);
	});

	it("recovers a renamed provider, writing under the host's new id", async () => {
		const f = fixture(["one"], blockedNow(), true, "anthropic-subscription");
		await f.run();
		expect(prop(f.states.get("one"), "blockReason")).toBeUndefined();
		expect(prop(f.credential, "accounts")).toEqual([
			{ name: "one", displayName: "same label", access: `${TOKEN}-one`, refresh: "refresh" },
		]);
		expect([...new Set(f.written)]).toEqual(["anthropic-subscription"]);
	});

	it("keeps account identity despite duplicate labels and only recovers the positive account", async () => {
		const f = fixture(["one", "two"]);
		vi.stubGlobal(
			"fetch",
			async (_url: string, options: { headers: { Authorization?: string } }) => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({
					five_hour: { utilization: options.headers.Authorization?.endsWith("-one") ? 10 : 100 },
					seven_day: { utilization: 20 },
				}),
			}),
		);
		await f.run();
		expect(prop(f.states.get("one"), "blockReason")).toBeUndefined();
		expect(prop(f.states.get("two"), "blockReason")).toBe("rate_limit");
	});

	it("recovers environment slotState and sidecar without persisting its token", async () => {
		const f = fixture(["env"]);
		f.credential = {
			...f.credential,
			accounts: [],
			slotState: {
				env: { blockReason: "rate_limit", blockedUntil: Date.now() + 60_000 },
			},
		};
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		await f.run();
		expect(prop(f.credential, "slotState")).toEqual({ env: {} });
		expect(prop(f.states.get("env"), "blockReason")).toBeUndefined();
		expect(JSON.stringify(f.credential)).not.toContain(TOKEN);
	});

	it.each([
		{ five_hour: { utilization: 100 }, seven_day: { utilization: 20 } },
		{ five_hour: { utilization: 10 }, seven_day: { utilization: 100 } },
		{ five_hour: { utilization: 10 } },
		null,
	])("does not recover zero or missing windows: %j", async (payload) => {
		const f = fixture();
		const before = structuredClone(f.credential);
		respond(payload);
		await f.run();
		expect(f.credential).toEqual(before);
		expect(prop(f.states.get("one"), "stateVersion")).toBe(1);
	});

	it.each(["auth_error", "account_disabled"])("preserves permanent %s blocks", async (reason) => {
		const f = fixture();
		f.states.set("one", { ...f.states.get("one"), blockReason: reason });
		const before = structuredClone(f.credential);
		await f.run();
		expect(f.credential).toEqual(before);
		expect(prop(f.states.get("one"), "blockReason")).toBe(reason);
		expect(f.notices.join("")).toContain("[Claude SDK] - blocked");
	});

	it.each(["credential", "block", "cancel"])(
		"preserves state after concurrent %s change",
		async (change) => {
			const f = fixture();
			vi.stubGlobal("fetch", async () => {
				if (change === "credential")
					f.credential = {
						...f.credential,
						accounts: [
							{
								name: "one",
								access: "rotated",
								blockReason: "rate_limit",
								blockedUntil: Date.now() + 60_000,
							},
						],
					};
				if (change === "block") f.states.set("one", { ...f.states.get("one"), stateVersion: 2 });
				if (change === "cancel") f.cancel();
				return {
					ok: true,
					status: 200,
					headers: { get: () => null },
					json: async () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
				};
			});
			await f.run();
			expect(prop(f.states.get("one"), "blockReason")).toBe("rate_limit");
			expect(JSON.stringify(f.credential)).toContain("rate_limit");
		},
	);

	it("reports the account unblocked when only the sidecar carried the block", async () => {
		const f = fixture(["one"], UNBLOCKED);
		f.states.set("one", { ...f.states.get("one"), ...blockedNow() });
		await f.run();
		expect(prop(f.states.get("one"), "blockReason")).toBeUndefined();
		expect(f.notices.join("")).toContain("[Claude SDK]");
		expect(f.notices.join("")).not.toContain("blocked");
	});

	it("records a rate-limit block in both places when the quota is exhausted", async () => {
		const f = fixture(["one"], UNBLOCKED);
		const resetAt = new Date(Date.now() + 3 * 3_600_000);
		respond({
			five_hour: { utilization: 100, resets_at: resetAt.toISOString() },
			seven_day: { utilization: 20 },
		});
		await f.run();
		expect(prop(f.credential, "accounts")).toEqual([
			{
				name: "one",
				displayName: "same label",
				access: `${TOKEN}-one`,
				refresh: "refresh",
				blockReason: "rate_limit",
				blockedUntil: resetAt.getTime(),
			},
		]);
		expect(prop(f.states.get("one"), "blockReason")).toBe("rate_limit");
		expect(prop(f.states.get("one"), "blockedUntil")).toBe(resetAt.getTime());
		expect(f.notices.join("")).toContain("[Claude SDK] - blocked");
	});

	it("creates a sidecar entry for an exhausted account the pool has no state for", async () => {
		const f = fixture(["one"], UNBLOCKED, false);
		const resetAt = new Date(Date.now() + 3 * 3_600_000);
		respond({
			five_hour: { utilization: 100, resets_at: resetAt.toISOString() },
			seven_day: { utilization: 20 },
		});
		await f.run();
		expect(f.states.get("one")).toEqual({
			credentialRevision: "stored-revision",
			blockReason: "rate_limit",
			blockedUntil: resetAt.getTime(),
			stateVersion: 1,
		});
		expect(prop(f.credential, "accounts")).toEqual([
			{
				name: "one",
				displayName: "same label",
				access: `${TOKEN}-one`,
				refresh: "refresh",
				blockReason: "rate_limit",
				blockedUntil: resetAt.getTime(),
			},
		]);
		expect(f.notices.join("")).toContain("[Claude SDK] - blocked");
	});

	it("creates an env sidecar entry with the env revision without persisting its token", async () => {
		const f = fixture(["env"], UNBLOCKED, false);
		f.credential = { ...f.credential, accounts: [], slotState: {} };
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		const resetAt = new Date(Date.now() + 2 * 3_600_000);
		respond({
			five_hour: { utilization: 100, resets_at: resetAt.toISOString() },
			seven_day: { utilization: 20 },
		});
		await f.run();
		expect(f.states.get("env")).toEqual({
			credentialRevision: "env-revision",
			blockReason: "rate_limit",
			blockedUntil: resetAt.getTime(),
			stateVersion: 1,
		});
		expect(prop(f.credential, "slotState")).toEqual({
			env: { blockReason: "rate_limit", blockedUntil: resetAt.getTime() },
		});
		expect(JSON.stringify(f.credential)).not.toContain(TOKEN);
		expect(JSON.stringify([...f.states])).not.toContain(TOKEN);
	});

	it("clears an auth-store-only block without creating a sidecar entry", async () => {
		const f = fixture(["one"], blockedNow(), false);
		await f.run();
		expect(prop(f.credential, "accounts")).toEqual([
			{
				name: "one",
				displayName: "same label",
				access: `${TOKEN}-one`,
				refresh: "refresh",
			},
		]);
		expect(f.states.has("one")).toBe(false);
		expect(f.notices.join("")).toContain("[Claude SDK]");
		expect(f.notices.join("")).not.toContain("blocked");
	});

	it("replaces an expired block with one that ends at the exhausted window's reset", async () => {
		const f = fixture(["one"], { blockReason: "rate_limit", blockedUntil: Date.now() - 60_000 });
		const resetAt = new Date(Date.now() + 90 * 60_000);
		respond({
			five_hour: { utilization: 10 },
			seven_day: { utilization: 100, resets_at: resetAt.toISOString() },
		});
		await f.run();
		expect(prop(f.states.get("one"), "blockedUntil")).toBe(resetAt.getTime());
		expect(f.notices.join("")).toContain("- blocked");
	});

	it("blocks for a minute without a reset time and caps a distant reset at two days", async () => {
		const before = Date.now();
		const short = fixture(["one"], UNBLOCKED);
		respond({ five_hour: { utilization: 100 }, seven_day: { utilization: 20 } });
		await short.run();
		const shortUntil = Number(prop(short.states.get("one"), "blockedUntil"));
		expect(shortUntil).toBeGreaterThanOrEqual(before + 60_000);
		expect(shortUntil).toBeLessThanOrEqual(Date.now() + 60_000);

		const capped = fixture(["one"], UNBLOCKED);
		respond({
			five_hour: { utilization: 100, resets_at: new Date(before + 10 * 86_400_000).toISOString() },
			seven_day: { utilization: 20 },
		});
		await capped.run();
		const cappedUntil = Number(prop(capped.states.get("one"), "blockedUntil"));
		expect(cappedUntil).toBeGreaterThanOrEqual(before + 172_800_000);
		expect(cappedUntil).toBeLessThanOrEqual(Date.now() + 172_800_000);
	});

	it("leaves an account that is already blocked untouched and still reports it blocked", async () => {
		const f = fixture();
		const before = structuredClone(f.credential);
		respond({ five_hour: { utilization: 100 }, seven_day: { utilization: 20 } });
		await f.run();
		expect(f.credential).toEqual(before);
		expect(prop(f.states.get("one"), "stateVersion")).toBe(1);
		expect(f.notices.join("")).toContain("[Claude SDK] - blocked");
	});

	it.each(["credential", "block", "cancel"])(
		"records no block after concurrent %s change",
		async (change) => {
			const f = fixture(["one"], UNBLOCKED);
			vi.stubGlobal("fetch", async () => {
				if (change === "credential")
					f.credential = {
						...f.credential,
						accounts: [{ name: "one", access: "rotated" }],
					};
				if (change === "block") f.states.set("one", { ...f.states.get("one"), stateVersion: 2 });
				if (change === "cancel") f.cancel();
				return {
					ok: true,
					status: 200,
					headers: { get: () => null },
					json: async () => ({ five_hour: { utilization: 100 }, seven_day: { utilization: 20 } }),
				};
			});
			await f.run();
			expect(JSON.stringify(f.credential)).not.toContain("rate_limit");
			expect(prop(f.states.get("one"), "blockReason")).toBeUndefined();
		},
	);

	it("still shows quota and a safe warning when persistence fails", async () => {
		const f = fixture();
		f.storage.modify = async () => {
			throw new Error(TOKEN);
		};
		await f.run();
		expect(f.notices.join("")).toContain("[Claude SDK]");
		expect(f.notices.join("")).toContain("Could not update quota rate-limit blocks");
		expect(f.notices.join("")).not.toContain(TOKEN);
	});
});

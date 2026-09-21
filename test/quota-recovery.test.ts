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

function fixture(names = ["one"]) {
	let credential: Value = {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		accounts: names.map((name) => ({
			name,
			displayName: "same label",
			access: `${TOKEN}-${name}`,
			refresh: "refresh",
			blockReason: "rate_limit",
			blockedUntil: Date.now() + 60_000,
		})),
	};
	const states = new Map<string, Value>();
	for (const name of names)
		states.set(name, {
			stateVersion: 1,
			credentialRevision: "revision",
			blockReason: "rate_limit",
			blockedUntil: Date.now() + 60_000,
			failureCount: 2,
		});
	const notices: string[] = [];
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let shutdown: (() => void) | undefined;
	const repository = {
		listSlots: async () => Object.fromEntries(states),
		storedCredentialRevision: async () => "revision",
		envCredentialRevision: async () => "revision",
		mutateSlotState: async (
			_provider: string,
			_lane: string,
			name: string,
			fn: (current: Value | undefined) => Value | undefined,
		) => {
			const next = fn(states.get(name));
			if (next) states.set(name, { ...next, stateVersion: Number(prop(next, "stateVersion")) + 1 });
			else states.delete(name);
		},
	};
	const storage = {
		listSlots: (provider: string) => (provider === PROVIDER ? prop(credential, "accounts") : []),
		read: async () => structuredClone(credential),
		modify: async (_provider: string, fn: (current: Value) => Promise<Value>) => {
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
		expect(f.notices.join("")).not.toContain(TOKEN);
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

	it("still shows quota and a safe warning when persistence fails", async () => {
		const f = fixture();
		f.storage.modify = async () => {
			throw new Error(TOKEN);
		};
		await f.run();
		expect(f.notices.join("")).toContain("[Claude SDK]");
		expect(f.notices.join("")).toContain("Could not clear");
		expect(f.notices.join("")).not.toContain(TOKEN);
	});
});

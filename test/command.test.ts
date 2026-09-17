import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
} from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaModelRegistry } from "../src/auth.ts";
import type { HttpResponseLike } from "../src/http.ts";
import registerQuotaExtension from "../src/index.ts";

const SECRET_TOKEN = "sk-command-canary-should-never-reach-the-ui-7b21";
const STATUS_KEY = "pi-quota";
const LOADING_TEXT = "Loading quota...";
const OPENAI_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage";

type NotifyType = "info" | "warning" | "error";

interface NotifyCall {
	readonly message: string;
	readonly type: NotifyType | undefined;
}

interface StatusCall {
	readonly key: string;
	readonly text: string | undefined;
}

interface CommandRegistration {
	readonly name: string;
	readonly description: string | undefined;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

type ShutdownHandler = (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void;

interface FakeHost {
	readonly pi: ExtensionAPI;
	readonly commands: CommandRegistration[];
	readonly shutdownHandlers: ShutdownHandler[];
}

/**
 * Minimal ExtensionAPI stand-in: records what the extension registers so the
 * tests can invoke the command handler and the shutdown handler directly.
 */
function fakeHost(): FakeHost {
	const commands: CommandRegistration[] = [];
	const shutdownHandlers: ShutdownHandler[] = [];
	const pi = {
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void {
			commands.push({ name, description: options.description, handler: options.handler });
		},
		on(event: string, handler: ShutdownHandler): void {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, commands, shutdownHandlers };
}

interface FakeContext {
	readonly ctx: ExtensionCommandContext;
	readonly notifyCalls: NotifyCall[];
	readonly statusCalls: StatusCall[];
}

/**
 * Minimal ExtensionCommandContext stand-in carrying only the members the
 * command handler is allowed to touch. It deliberately omits sendMessage- and
 * appendEntry-style members: any attempt to start a model turn throws.
 */
function fakeContext(options: {
	readonly registry: QuotaModelRegistry;
	readonly hasUI?: boolean;
}): FakeContext {
	const notifyCalls: NotifyCall[] = [];
	const statusCalls: StatusCall[] = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		modelRegistry: options.registry,
		ui: {
			notify(message: string, type?: NotifyType): void {
				notifyCalls.push({ message, type });
			},
			setStatus(key: string, text: string | undefined): void {
				statusCalls.push({ key, text });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifyCalls, statusCalls };
}

function bothProvidersRegistry(token = SECRET_TOKEN): QuotaModelRegistry {
	return {
		getAvailable: () => [{ provider: "openai-codex" }, { provider: "anthropic" }],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
	};
}

function openAiOnlyRegistry(): QuotaModelRegistry {
	return {
		getAvailable: () => [{ provider: "openai-codex" }],
		isUsingOAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: SECRET_TOKEN }),
	};
}

interface PoolSlot {
	readonly name: string;
	readonly displayName?: string;
}

/**
 * Host that pools credential accounts: `listSlots` enumerates them and
 * slot-scoped `getAuth` hands out a token per account, which is exactly the
 * boundary the command uses for a per-account lookup.
 */
function pooledRegistry(
	slotsByProvider: Readonly<Record<string, readonly PoolSlot[]>>,
	unresolvableAccounts: readonly string[] = [],
): QuotaModelRegistry {
	return {
		...bothProvidersRegistry(),
		authStorage: {
			listSlots: (provider: string) => slotsByProvider[provider] ?? [],
		},
		modelRuntime: {
			getAuth: async (_provider: unknown, overrides: unknown) => {
				const slotName =
					typeof overrides === "object" && overrides !== null
						? Reflect.get(overrides, "slotName")
						: undefined;
				if (typeof slotName !== "string" || unresolvableAccounts.includes(slotName)) {
					return undefined;
				}
				return { auth: { apiKey: `${SECRET_TOKEN}-${slotName}` } };
			},
		},
	};
}

function noOAuthRegistry(): QuotaModelRegistry {
	return {
		getAvailable: () => [],
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: false }),
	};
}

function jsonResponse(body: unknown): HttpResponseLike {
	return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

function errorResponse(status: number, retryAfter?: string): HttpResponseLike {
	return {
		ok: false,
		status,
		headers: {
			get: (name: string) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
		},
		json: async () => {
			throw new Error("body must never be read");
		},
	};
}

const OPENAI_USAGE = {
	plan_type: "pro",
	rate_limit: {
		limit_reached: false,
		primary_window: { used_percent: 18, limit_window_seconds: 18_000 },
		secondary_window: { used_percent: 39, limit_window_seconds: 604_800 },
	},
};

const ANTHROPIC_USAGE = {
	five_hour: { utilization: 26 },
	seven_day: { utilization: 52 },
};

/**
 * The command passes only ctx.modelRegistry to the providers, so the providers
 * fall through to the ambient global fetch. Stubbing it exercises the real
 * auth/http/provider/format stack end-to-end with no network access and no
 * test-only seam in src/index.ts.
 */
interface StubbedFetch {
	readonly urls: string[];
	readonly signals: AbortSignal[];
}

type Responder = (url: string, signal: AbortSignal) => Promise<HttpResponseLike>;

function stubFetch(respond: Responder): StubbedFetch {
	const urls: string[] = [];
	const signals: AbortSignal[] = [];
	vi.stubGlobal(
		"fetch",
		(url: string, init: { signal: AbortSignal }): Promise<HttpResponseLike> => {
			urls.push(url);
			signals.push(init.signal);
			return respond(url, init.signal);
		},
	);
	return { urls, signals };
}

function usageFor(url: string): unknown {
	return url === OPENAI_URL ? OPENAI_USAGE : ANTHROPIC_USAGE;
}

function stubSuccessFetch(): StubbedFetch {
	return stubFetch(async (url) => jsonResponse(usageFor(url)));
}

/** Rejects only once its own request signal aborts - no timers, no sleeps. */
function stubNeverResolvingFetch(): StubbedFetch {
	return stubFetch(
		(_url, signal) =>
			new Promise<HttpResponseLike>((_resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	);
}

interface GatedFetch extends StubbedFetch {
	/** Resolves once `count` requests have reached the transport. */
	inFlight(count: number): Promise<void>;
	release(): void;
}

/**
 * A fetch whose responses are released manually, so a test can hold one
 * invocation's providers open while a later invocation supersedes it.
 */
function stubGatedFetch(): GatedFetch {
	const pendingSettles: Array<() => void> = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	let released = false;
	let started = 0;

	const stub = stubFetch(
		(url, signal) =>
			new Promise<HttpResponseLike>((resolve, reject) => {
				started += 1;
				for (const waiter of waiters.splice(0).filter((entry) => {
					if (entry.count <= started) return true;
					waiters.push(entry);
					return false;
				})) {
					waiter.resolve();
				}
				const settle = () => resolve(jsonResponse(usageFor(url)));
				if (released) {
					settle();
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				pendingSettles.push(settle);
			}),
	);

	return {
		...stub,
		inFlight: (count: number) =>
			started >= count
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						waiters.push({ count, resolve });
					}),
		release: () => {
			released = true;
			for (const settle of pendingSettles.splice(0)) settle();
		},
	};
}

function loadExtension(): FakeHost {
	const host = fakeHost();
	registerQuotaExtension(host.pi);
	return host;
}

function quotaCommand(host: FakeHost): CommandRegistration {
	const command = host.commands.find((entry) => entry.name === "quota");
	if (!command) throw new Error("quota command was not registered");
	return command;
}

function shutdownHandler(host: FakeHost): ShutdownHandler {
	const handler = host.shutdownHandlers[0];
	if (!handler) throw new Error("session_shutdown handler was not registered");
	return handler;
}

function firstNotify(fake: FakeContext): NotifyCall {
	const call = fake.notifyCalls[0];
	if (!call) throw new Error("expected at least one notify call");
	return call;
}

function expectNoSecretLeak(fake: FakeContext): void {
	for (const call of fake.notifyCalls) {
		expect(call.message).not.toContain(SECRET_TOKEN);
	}
	for (const call of fake.statusCalls) {
		expect(call.text ?? "").not.toContain(SECRET_TOKEN);
	}
}

const REAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
	setPlatform(REAL_PLATFORM);
	vi.unstubAllGlobals();
});

describe("quota extension registration", () => {
	it("registers a single quota command with a non-empty description", () => {
		const host = loadExtension();

		expect(host.commands).toHaveLength(1);
		const command = quotaCommand(host);
		expect(command.name).toBe("quota");
		expect(command.description ?? "").not.toHaveLength(0);
	});

	it("registers a session_shutdown handler", () => {
		const host = loadExtension();

		expect(host.shutdownHandlers).toHaveLength(1);
	});
});

describe("quota command happy path", () => {
	it("renders both providers in exactly one info notification", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		const notification = firstNotify(fake);
		expect(notification.message).toContain("OpenAI");
		expect(notification.message).toContain("Anthropic");
		expect(notification.type).toBe("info");
		expect(new Set(urls)).toEqual(new Set([OPENAI_URL, ANTHROPIC_URL]));
		expectNoSecretLeak(fake);
	});

	it("sets a loading status and clears the same status key afterwards", async () => {
		const host = loadExtension();
		stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.statusCalls).toEqual([
			{ key: STATUS_KEY, text: LOADING_TEXT },
			{ key: STATUS_KEY, text: undefined },
		]);
		expectNoSecretLeak(fake);
	});

	it("issues both provider requests concurrently under one live invocation", async () => {
		const host = loadExtension();
		const gate = stubGatedFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		const pending = quotaCommand(host).handler("", fake.ctx);
		await gate.inFlight(2);

		expect(gate.signals).toHaveLength(2);
		for (const signal of gate.signals) {
			expect(signal.aborted).toBe(false);
		}

		gate.release();
		await pending;
		expect(fake.notifyCalls).toHaveLength(1);
	});
});

describe("quota command with pooled credential accounts", () => {
	it("renders one labelled block per account and leaves a single account unlabelled", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({
			registry: pooledRegistry({
				"openai-codex": [{ name: "default" }, { name: "login-2", displayName: "work" }],
				anthropic: [{ name: "default" }],
			}),
		});

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		const notification = firstNotify(fake);
		expect(notification.type).toBe("info");
		expect(notification.message).toContain("[OpenAI: default]");
		expect(notification.message).toContain("[OpenAI: work]");
		expect(notification.message).toContain("[Anthropic]");
		expect(notification.message).not.toContain("[Anthropic:");
		expect(urls.filter((url) => url === OPENAI_URL)).toHaveLength(2);
		expect(urls.filter((url) => url === ANTHROPIC_URL)).toHaveLength(1);
		expectNoSecretLeak(fake);
	});

	it("keeps one account's quota when a sibling account resolves no credential", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({
			registry: pooledRegistry(
				{
					"openai-codex": [{ name: "default" }, { name: "login-2", displayName: "work" }],
					anthropic: [{ name: "default" }],
				},
				["login-2"],
			),
		});

		await quotaCommand(host).handler("", fake.ctx);

		const notification = firstNotify(fake);
		expect(notification.type).toBe("warning");
		expect(notification.message).toContain("[OpenAI: work]: not signed in with OAuth");
		expect(notification.message).toContain("Five-hour");
		expect(urls.filter((url) => url === OPENAI_URL)).toHaveLength(1);
		expectNoSecretLeak(fake);
	});

	it("reads every account of one invocation concurrently", async () => {
		const host = loadExtension();
		const gate = stubGatedFetch();
		const fake = fakeContext({
			registry: pooledRegistry({
				"openai-codex": [{ name: "default" }, { name: "login-2" }],
				anthropic: [{ name: "default" }, { name: "login-2" }],
			}),
		});

		const pending = quotaCommand(host).handler("", fake.ctx);
		await gate.inFlight(4);

		expect(gate.signals).toHaveLength(4);
		gate.release();
		await pending;

		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).type).toBe("info");
	});
});

describe("quota command guards", () => {
	it("shows usage and starts no request when an argument is passed", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("foo", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		const notification = firstNotify(fake);
		expect(notification.type).toBe("info");
		expect(notification.message.toLowerCase()).toContain("quota");
		expect(notification.message.toLowerCase()).toMatch(/usage|argument|takes no/);
		expect(fake.statusCalls).toHaveLength(0);
		expect(urls).toHaveLength(0);
	});

	it("treats whitespace-only arguments as no arguments", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("   ", fake.ctx);

		expect(urls).toHaveLength(2);
		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).type).toBe("info");
	});

	for (const platform of ["linux", "darwin", "win32"] as const) {
		it(`runs the full lookup on ${platform}`, async () => {
			setPlatform(platform);
			const host = loadExtension();
			const { urls } = stubSuccessFetch();
			const fake = fakeContext({ registry: bothProvidersRegistry() });

			await quotaCommand(host).handler("", fake.ctx);

			expect(fake.notifyCalls).toHaveLength(1);
			expect(firstNotify(fake).type).toBe("info");
			expect(new Set(urls)).toEqual(new Set([OPENAI_URL, ANTHROPIC_URL]));
		});
	}

	it("shows the scope message and starts no request without dialog-capable UI", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry(), hasUI: false });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).type).toBe("info");
		expect(fake.statusCalls).toHaveLength(0);
		expect(urls).toHaveLength(0);
	});

	it("checks the argument guard before the UI guard", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry(), hasUI: false });

		await quotaCommand(host).handler("bogus", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).message.toLowerCase()).toMatch(/usage|argument|takes no/);
		expect(urls).toHaveLength(0);
	});
});

describe("quota command severity", () => {
	it("uses info when both providers succeed", async () => {
		const host = loadExtension();
		stubSuccessFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(firstNotify(fake).type).toBe("info");
	});

	it("uses warning and still shows the working provider when the other has no OAuth", async () => {
		const host = loadExtension();
		const { urls } = stubFetch(async (url) => jsonResponse(usageFor(url)));
		const fake = fakeContext({ registry: openAiOnlyRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		const notification = firstNotify(fake);
		expect(notification.type).toBe("warning");
		expect(notification.message).toContain("OpenAI");
		expect(notification.message).toContain("82%");
		expect(notification.message).toContain("61%");
		expect(notification.message).toContain("Anthropic");
		expect(urls).toEqual([OPENAI_URL]);
		expectNoSecretLeak(fake);
	});

	it("uses error when neither provider has OAuth configured", async () => {
		const host = loadExtension();
		const { urls } = stubSuccessFetch();
		const fake = fakeContext({ registry: noOAuthRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).type).toBe("error");
		expect(urls).toHaveLength(0);
	});
});

describe("quota command transport failures", () => {
	for (const status of [401, 429, 500]) {
		it(`produces one coherent notification for an HTTP ${status} response`, async () => {
			const host = loadExtension();
			stubFetch(async () => errorResponse(status, status === 429 ? "30" : undefined));
			const fake = fakeContext({ registry: bothProvidersRegistry() });

			await quotaCommand(host).handler("", fake.ctx);

			expect(fake.notifyCalls).toHaveLength(1);
			const notification = firstNotify(fake);
			expect(notification.type).toBe("error");
			expect(notification.message).toContain(`HTTP ${status}`);
			expect(fake.statusCalls[fake.statusCalls.length - 1]?.text).toBeUndefined();
			expectNoSecretLeak(fake);
		});
	}

	it("produces one coherent notification for malformed JSON", async () => {
		const host = loadExtension();
		stubFetch(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => {
				throw new SyntaxError(`unexpected token near ${SECRET_TOKEN}`);
			},
		}));
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).type).toBe("error");
		expect(fake.statusCalls[fake.statusCalls.length - 1]?.text).toBeUndefined();
		expectNoSecretLeak(fake);
	});

	it("produces one coherent notification when the network layer rejects", async () => {
		const host = loadExtension();
		stubFetch(async () => {
			throw new TypeError(`fetch failed for ${SECRET_TOKEN}`);
		});
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		expect(firstNotify(fake).type).toBe("error");
		expectNoSecretLeak(fake);
	});

	it("keeps one provider's failure from hiding the other provider's success", async () => {
		const host = loadExtension();
		stubFetch(async (url) =>
			url === OPENAI_URL ? errorResponse(500) : jsonResponse(ANTHROPIC_USAGE),
		);
		const fake = fakeContext({ registry: bothProvidersRegistry() });

		await quotaCommand(host).handler("", fake.ctx);

		expect(fake.notifyCalls).toHaveLength(1);
		const notification = firstNotify(fake);
		expect(notification.type).toBe("warning");
		expect(notification.message).toContain("HTTP 500");
		expect(notification.message).toContain("74%");
		expectNoSecretLeak(fake);
	});
});

describe("quota command cancellation", () => {
	it("lets only the newest invocation publish results when re-invoked rapidly", async () => {
		const host = loadExtension();
		const gate = stubGatedFetch();
		const staleFake = fakeContext({ registry: bothProvidersRegistry() });
		const freshFake = fakeContext({ registry: bothProvidersRegistry() });
		const command = quotaCommand(host);

		const stale = command.handler("", staleFake.ctx);
		await gate.inFlight(2);
		const staleSignals = [...gate.signals];

		const fresh = command.handler("", freshFake.ctx);
		await gate.inFlight(4);
		gate.release();
		await Promise.all([stale, fresh]);

		expect(staleFake.notifyCalls).toHaveLength(0);
		expect(freshFake.notifyCalls).toHaveLength(1);
		const notification = firstNotify(freshFake);
		expect(notification.message).toContain("OpenAI");
		expect(notification.message).toContain("Anthropic");
		for (const signal of staleSignals) {
			expect(signal.aborted).toBe(true);
		}
		expectNoSecretLeak(staleFake);
		expectNoSecretLeak(freshFake);
	});

	it("drops a stale invocation's already-fetched results instead of clobbering the newer one", async () => {
		const host = loadExtension();
		const gate = stubGatedFetch();
		const staleFake = fakeContext({ registry: bothProvidersRegistry() });
		const freshFake = fakeContext({ registry: bothProvidersRegistry() });
		const command = quotaCommand(host);

		// The stale invocation's providers both resolve successfully first, so it
		// reaches its post-Promise.all continuation with real results in hand.
		const stale = command.handler("", staleFake.ctx);
		await gate.inFlight(2);
		gate.release();
		const fresh = command.handler("", freshFake.ctx);
		await Promise.all([stale, fresh]);

		expect(staleFake.notifyCalls).toHaveLength(0);
		expect(staleFake.statusCalls).toEqual([{ key: STATUS_KEY, text: LOADING_TEXT }]);
		expect(freshFake.notifyCalls).toHaveLength(1);
		expect(firstNotify(freshFake).type).toBe("info");
	});

	it("never lets a superseded invocation clear the newer invocation's status", async () => {
		const host = loadExtension();
		const gate = stubGatedFetch();
		const staleFake = fakeContext({ registry: bothProvidersRegistry() });
		const freshFake = fakeContext({ registry: bothProvidersRegistry() });
		const command = quotaCommand(host);

		const stale = command.handler("", staleFake.ctx);
		await gate.inFlight(2);
		const fresh = command.handler("", freshFake.ctx);
		await gate.inFlight(4);
		gate.release();
		await Promise.all([stale, fresh]);

		expect(staleFake.statusCalls).toEqual([{ key: STATUS_KEY, text: LOADING_TEXT }]);
		expect(freshFake.statusCalls).toEqual([
			{ key: STATUS_KEY, text: LOADING_TEXT },
			{ key: STATUS_KEY, text: undefined },
		]);
	});
});

describe("quota command session shutdown", () => {
	it("aborts the in-flight request and never notifies for the cancelled invocation", async () => {
		const host = loadExtension();
		const stub = stubNeverResolvingFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });
		const command = quotaCommand(host);

		const pending = command.handler("", fake.ctx);
		while (stub.signals.length < 2) {
			await Promise.resolve();
		}

		const shutdownCtx = fakeContext({ registry: noOAuthRegistry() });
		await shutdownHandler(host)(
			{ type: "session_shutdown" } as SessionShutdownEvent,
			shutdownCtx.ctx,
		);
		await pending;

		for (const signal of stub.signals) {
			expect(signal.aborted).toBe(true);
		}
		expect(fake.notifyCalls).toHaveLength(0);
		expect(fake.statusCalls).toEqual([{ key: STATUS_KEY, text: LOADING_TEXT }]);
		expect(shutdownCtx.notifyCalls).toHaveLength(0);
		expect(shutdownCtx.statusCalls).toEqual([{ key: STATUS_KEY, text: undefined }]);
	});

	it("clears the status even when no request is in flight", async () => {
		const host = loadExtension();
		const shutdownCtx = fakeContext({ registry: noOAuthRegistry() });

		await shutdownHandler(host)(
			{ type: "session_shutdown" } as SessionShutdownEvent,
			shutdownCtx.ctx,
		);

		expect(shutdownCtx.statusCalls).toEqual([{ key: STATUS_KEY, text: undefined }]);
		expect(shutdownCtx.notifyCalls).toHaveLength(0);
	});

	it("lets a later invocation run normally after a shutdown cancelled an earlier one", async () => {
		const host = loadExtension();
		const stub = stubNeverResolvingFetch();
		const fake = fakeContext({ registry: bothProvidersRegistry() });
		const command = quotaCommand(host);

		const pending = command.handler("", fake.ctx);
		while (stub.signals.length < 2) {
			await Promise.resolve();
		}
		const shutdownCtx = fakeContext({ registry: noOAuthRegistry() });
		await shutdownHandler(host)(
			{ type: "session_shutdown" } as SessionShutdownEvent,
			shutdownCtx.ctx,
		);
		await pending;

		stubSuccessFetch();
		const laterFake = fakeContext({ registry: bothProvidersRegistry() });
		await command.handler("", laterFake.ctx);

		expect(laterFake.notifyCalls).toHaveLength(1);
		expect(firstNotify(laterFake).type).toBe("info");
		expect(laterFake.statusCalls).toEqual([
			{ key: STATUS_KEY, text: LOADING_TEXT },
			{ key: STATUS_KEY, text: undefined },
		]);
	});
});

describe("quota command credential safety", () => {
	it("never passes the access token to notify or setStatus on any path", async () => {
		const host = loadExtension();
		const command = quotaCommand(host);

		const paths: ReadonlyArray<() => Promise<FakeContext>> = [
			async () => {
				stubSuccessFetch();
				const fake = fakeContext({ registry: bothProvidersRegistry() });
				await command.handler("", fake.ctx);
				return fake;
			},
			async () => {
				stubFetch(async () => errorResponse(401));
				const fake = fakeContext({ registry: bothProvidersRegistry() });
				await command.handler("", fake.ctx);
				return fake;
			},
			async () => {
				stubFetch(async () => {
					throw new TypeError(`fetch failed with ${SECRET_TOKEN}`);
				});
				const fake = fakeContext({ registry: bothProvidersRegistry() });
				await command.handler("", fake.ctx);
				return fake;
			},
			async () => {
				stubSuccessFetch();
				const registry: QuotaModelRegistry = {
					getAvailable: () => [{ provider: "openai-codex" }, { provider: "anthropic" }],
					isUsingOAuth: () => true,
					getApiKeyAndHeaders: async () => {
						throw new Error(`token ${SECRET_TOKEN} is expired`);
					},
				};
				const fake = fakeContext({ registry });
				await command.handler("", fake.ctx);
				return fake;
			},
		];

		for (const run of paths) {
			const fake = await run();
			expect(fake.notifyCalls.length).toBeGreaterThan(0);
			expectNoSecretLeak(fake);
			vi.unstubAllGlobals();
		}
	});
});

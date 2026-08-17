import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
	getDefaultEnvironment,
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import { afterEach } from "vitest";

import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";
import { writeStoredTokens } from "@/whoop/auth/tokens/store";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const builtEntry = fileURLToPath(
	new URL("../../dist/index.js", import.meta.url),
);

type Cleanup = () => void | Promise<void>;
const deferredCleanups: Cleanup[] = [];

/** Registers teardown for resources opened by the current non-concurrent test. */
export function deferCleanup(cleanup: Cleanup): void {
	deferredCleanups.push(cleanup);
}

/** Drains every registered cleanup in reverse order and reports all failures. */
export async function runDeferredCleanups(): Promise<void> {
	const failures: unknown[] = [];
	for (const cleanup of deferredCleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, "One or more test cleanups failed");
	}
}

// This worker-local registry deliberately does not support `it.concurrent`.
afterEach(async () => {
	await runDeferredCleanups();
});

/** Starts a loopback server and schedules it to close after the test. */
export async function listenOnLoopback(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	deferCleanup(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);

	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A loopback redirect URI nothing is listening on, so the code under test is
 * what binds its port. Binds and releases only to learn a free port number.
 */
export async function unusedRedirectUri(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});

	return `http://127.0.0.1:${port}/callback`;
}

/** Creates an isolated token-store directory for one test. */
export async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-test-"));
	deferCleanup(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** Seeds a live login; `offline` is store policy rather than fixture input. */
export async function seedStore(
	store: string,
	readScopes: readonly string[] = DEFAULT_READ_SCOPES,
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes: [...new Set([...readScopes, OFFLINE_SCOPE])],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/** What a URL-mode elicitation asks a client to put in front of its user. */
export type ElicitedUrl = {
	readonly url: string;
	readonly message: string;
};

/** The three answers a client may give an elicitation. */
export type ElicitedAction = "accept" | "decline" | "cancel";

/**
 * How a harness client behaves toward URL-mode elicitation. Supplying this
 * makes the client declare `elicitation: { url: {} }`. `browser` stands in
 * for the user's browser: handed the elicited URL, it acts as a consenting or
 * refusing user would and returns the action the client reports. With one,
 * the SDK's multi-round-trip driver fulfils the elicitation and retries by
 * itself, so a whole login happens inside one `callTool`.
 */
export type UrlElicitation = {
	readonly browser?: (
		elicited: ElicitedUrl,
	) => ElicitedAction | Promise<ElicitedAction>;
};

/**
 * What a harness client declares under `capabilities.elicitation`: `"url"` is
 * `{ url: {} }` (URL mode); `"form"` is a bare `{}`, which the specification
 * reads as form mode only. Left out, no elicitation capability is declared.
 * Supplying {@link BuiltStdioClientOptions.urlElicitation} implies `"url"`.
 */
export type ElicitationCapability = "url" | "form";

/** What a harness client declares, by the shorthand naming its mode. */
const ELICITATION_CAPABILITIES = {
	url: { url: {} },
	form: {},
} as const satisfies Record<ElicitationCapability, object>;

/**
 * Which protocol revision a harness client speaks: `"2026-07-28"` carries
 * capabilities per request in the `_meta` envelope and retries
 * `input_required` itself; `"legacy"` is the 2025-era handshake — capabilities
 * declared once at `initialize`, no per-request envelope.
 */
export type ClientProtocol = "2026-07-28" | "legacy";

export type BuiltStdioClientOptions = {
	readonly name?: string;
	readonly args?: readonly string[];
	readonly store?: string;
	readonly whoopBaseUrl?: string;
	readonly credentials?: {
		readonly clientId: string;
		readonly clientSecret: string;
	};
	readonly redirectUri?: string;
	readonly httpTimeoutMs?: number;
	readonly logLevel?: string;
	readonly env?: Record<string, string>;
	readonly inheritEnvironment?: boolean;
	readonly protocolVersion?: ClientProtocol;
	readonly elicitation?: ElicitationCapability;
	readonly urlElicitation?: UrlElicitation;
	readonly stderr?: StdioServerParameters["stderr"];
};

/** Owns the built server's stdio client, process environment, and lifecycle. */
export async function withBuiltStdioClient<T>(
	use: (
		client: Client,
		transport: StdioClientTransport,
		stderr: () => string,
	) => Promise<T>,
): Promise<T>;
export async function withBuiltStdioClient<T>(
	options: BuiltStdioClientOptions,
	use: (
		client: Client,
		transport: StdioClientTransport,
		stderr: () => string,
	) => Promise<T>,
): Promise<T>;
export async function withBuiltStdioClient<T>(
	optionsOrUse:
		| BuiltStdioClientOptions
		| ((
				client: Client,
				transport: StdioClientTransport,
				stderr: () => string,
		  ) => Promise<T>),
	maybeUse?: (
		client: Client,
		transport: StdioClientTransport,
		stderr: () => string,
	) => Promise<T>,
): Promise<T> {
	const options = typeof optionsOrUse === "function" ? {} : optionsOrUse;
	const use = typeof optionsOrUse === "function" ? optionsOrUse : maybeUse;
	if (use === undefined) {
		throw new TypeError("withBuiltStdioClient requires a callback");
	}
	const {
		name = "built-stdio-test",
		args = [],
		store,
		whoopBaseUrl,
		credentials,
		redirectUri,
		httpTimeoutMs,
		logLevel,
		env = {},
		inheritEnvironment = true,
		protocolVersion = "2026-07-28",
		urlElicitation,
		elicitation = urlElicitation ? "url" : undefined,
		stderr = "ignore",
	} = options;
	const client = new Client(
		{ name, version: "0.0.0" },
		{
			versionNegotiation: {
				mode:
					protocolVersion === "legacy" ? "legacy" : { pin: protocolVersion },
			},
			...(elicitation
				? {
						capabilities: {
							elicitation: ELICITATION_CAPABILITIES[elicitation],
						},
					}
				: {}),
		},
	);
	const browser = urlElicitation?.browser;
	if (browser) {
		client.setRequestHandler("elicitation/create", async ({ params }) => {
			// This client declared URL mode only; decline anything else.
			if (params.mode !== "url") {
				return { action: "decline" };
			}

			return {
				action: await browser({ url: params.url, message: params.message }),
			};
		});
	}
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry, ...args],
		cwd: repoRoot,
		env: {
			...(inheritEnvironment ? getDefaultEnvironment() : {}),
			...(store === undefined ? {} : { WHOOP_TOKEN_STORE: store }),
			...(whoopBaseUrl === undefined
				? {}
				: { WHOOP_API_BASE_URL: whoopBaseUrl }),
			...(credentials === undefined
				? {}
				: {
						WHOOP_CLIENT_ID: credentials.clientId,
						WHOOP_CLIENT_SECRET: credentials.clientSecret,
					}),
			...(redirectUri === undefined ? {} : { WHOOP_REDIRECT_URI: redirectUri }),
			...(httpTimeoutMs === undefined
				? {}
				: { WHOOP_HTTP_TIMEOUT_MS: String(httpTimeoutMs) }),
			...(logLevel === undefined ? {} : { WHOOP_LOG_LEVEL: logLevel }),
			...env,
		},
		stderr,
	});
	const stderrChunks: Buffer[] = [];
	transport.stderr?.on("data", (chunk: Buffer) => {
		stderrChunks.push(chunk);
	});

	await client.connect(transport);
	try {
		return await use(client, transport, () =>
			Buffer.concat(stderrChunks).toString("utf8"),
		);
	} finally {
		await client.close();
	}
}

export type ToolOutcome = {
	readonly rejected: boolean;
	readonly failed: boolean;
	readonly text: string;
};

/** Normalizes the SDK's rejected and `isError` tool-failure surfaces. */
export async function callToolOutcome(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
	try {
		const result = await client.callTool({ name, arguments: args });

		return {
			rejected: false,
			failed: result.isError === true,
			text: JSON.stringify(result.content),
		};
	} catch (error) {
		return { rejected: true, failed: true, text: String(error) };
	}
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { runLogin } from "@/auth/login";
import { writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** Starts a loopback server and reports the origin it ended up on. */
async function listenOnLoopback(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	opened.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	);

	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-profile-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** The profile the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** One request the stand-in WHOOP was asked to serve. */
type WhoopRequest = {
	method: string;
	path: string;
	authorization: string | undefined;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/** How the stand-in WHOOP answers each path it knows. */
const ANSWERS: Record<string, unknown> = {
	"/developer/v2/user/profile/basic": PROFILE,
	"/oauth/oauth2/token": {
		access_token: "an-access-token",
		refresh_token: "a-refresh-token",
		expires_in: 3600,
		scope: "read:profile offline",
		token_type: "bearer",
	},
};

/**
 * A stand-in WHOOP for the whole login-then-read loop: it exchanges an
 * authorization code, serves the v2 basic-profile endpoint, and records every
 * request, so a case can assert what was actually sent upstream.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://whoop.invalid").pathname;
		requests.push({
			method: request.method ?? "",
			path,
			authorization: request.headers.authorization,
		});
		request.resume();
		request.on("end", () => {
			const answer = ANSWERS[path];
			response.writeHead(answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/**
 * A redirect URI nothing is listening on yet, so the login command is the one
 * that binds its port.
 */
async function unusedRedirectUri(): Promise<string> {
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

/**
 * Runs a whole real `login` against the stand-in WHOOP — the printed authorize
 * URL, the browser's trip back to the loopback redirect, the code exchange —
 * leaving whatever it stores in the given store directory.
 */
async function loginAgainst(whoop: FakeWhoop, store: string): Promise<number> {
	const redirectUri = await unusedRedirectUri();

	let announce: (url: URL) => void = () => {};
	const authorizeUrl = new Promise<URL>((resolve) => {
		announce = resolve;
	});

	const exitCode = runLogin({
		env: {
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: "a-client-secret",
			WHOOP_REDIRECT_URI: redirectUri,
			WHOOP_API_BASE_URL: whoop.baseUrl,
			WHOOP_TOKEN_STORE: store,
		},
		print: (message) => {
			const found = message.match(/https?:\/\/\S*\/oauth\/oauth2\/auth\S*/);
			if (found) {
				announce(new URL(found[0]));
			}
		},
		printFailure: () => {},
		openBrowser: () => {},
	});

	// Play the browser arriving at the loopback redirect.
	const back = new URL(redirectUri);
	back.searchParams.set("code", "an-authorization-code");
	back.searchParams.set(
		"state",
		(await authorizeUrl).searchParams.get("state") ?? "",
	);
	await fetch(back);

	return exitCode;
}

/** The tokens a completed login would have left behind. */
const SEEDED_TOKENS = {
	accessToken: "an-access-token",
	refreshToken: "a-refresh-token",
	expiresAt: Date.now() + 3_600_000,
	scopes: ["read:profile", "offline"],
};

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP.
 */
async function withClient<T>(
	env: { store: string; whoopBaseUrl: string },
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({
		name: "profile-over-stdio-test",
		version: "0.0.0",
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
		},
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

/** The text of a result's content, so mirrors can be asserted on. */
function textOf(result: { content?: unknown }): string {
	const content = (result.content ?? []) as { type: string; text?: string }[];

	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("get_profile with a stored login, over real stdio", () => {
	it("reads WHOOP's v2 profile with the stored bearer token and mirrors it", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await writeStoredTokens(SEEDED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const { declared, result } = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				declared: (await client.listTools()).tools.find(
					(tool) => tool.name === "get_profile",
				),
				result: await client.callTool({ name: "get_profile", arguments: {} }),
			}),
		);

		expect(whoop.requests).toContainEqual({
			method: "GET",
			path: "/developer/v2/user/profile/basic",
			authorization: "Bearer an-access-token",
		});

		expect(declared?.outputSchema).toMatchObject({ type: "object" });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);

		const mirror = textOf(result);
		expect(mirror).toContain("ada@example.com");
		expect(mirror).toContain("Ada");
		expect(mirror).toContain("Lovelace");
	}, 30_000);

	it("serves a profile from the store a real login run left behind", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		expect(await loginAgainst(whoop, store)).toBe(0);

		// A fresh server process — not the process that logged in — serves the
		// call, so the only thing the two can share is the token store.
		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);
	}, 30_000);

	it("suggests logging in again when the store is corrupt, and keeps serving", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await writeFile(join(store, "tokens.json"), "not json at all", "utf8");

		const { outcome, afterwards } = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => {
				const result = await client
					.callTool({ name: "get_profile", arguments: {} })
					.then((value) => ({
						failed: value.isError === true,
						text: JSON.stringify(value.content),
					}))
					.catch((error: unknown) => ({ failed: true, text: String(error) }));

				return { outcome: result, afterwards: await client.listTools() };
			},
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("npx mcp-whoop login");
		expect(afterwards.tools.map((tool) => tool.name)).toContain("get_profile");
	}, 30_000);
});

import { mkdtemp, rm } from "node:fs/promises";
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

/**
 * The token material planted and then searched for on every outward surface.
 * Each string is distinctive enough that finding it in any output means the
 * real value leaked rather than a coincidental match.
 */
const ACCESS_TOKEN = "access-token-1f7d2c9a504e";
const REFRESH_TOKEN = "refresh-token-9b3e6a1d8c40";
const CLIENT_SECRET = "client-secret-5d2a7f4b9e13";
const AUTHORIZATION_CODE = "authorization-code-3c8f1b6d2a97";

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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-redaction-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** One canned answer a stand-in WHOOP endpoint gives. */
type Answer = { status: number; body: unknown };

/**
 * A stand-in WHOOP whose answers a case scripts per endpoint, including error
 * bodies that echo token material back the way WHOOP's own can.
 */
async function startFakeWhoop(answers: {
	token?: Answer;
	profile?: Answer;
}): Promise<{ baseUrl: string }> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const path = new URL(request.url ?? "/", "http://whoop.invalid").pathname;
			const answer =
				path === "/oauth/oauth2/token"
					? answers.token
					: path === "/developer/v2/user/profile/basic"
						? answers.profile
						: undefined;

			response.writeHead(answer?.status ?? 404, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer?.body ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server) };
}

/** Seeds the store with a login carrying the marked token pair above. */
async function seedLogin(store: string, options: { expired: boolean }) {
	await writeStoredTokens(
		{
			accessToken: ACCESS_TOKEN,
			refreshToken: REFRESH_TOKEN,
			expiresAt: Date.now() + (options.expired ? -60_000 : 3_600_000),
			scopes: ["read:profile", "offline"],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * The same promise, but reported as a legible failure when it stalls — a login
 * that never prints or never finishes should name what it was waiting for
 * rather than sit there until the runner gives up.
 */
function within<T>(work: Promise<T>, what: string): Promise<T> {
	return Promise.race([
		work,
		new Promise<T>((_resolve, reject) => {
			setTimeout(() => {
				reject(new Error(`timed out waiting for ${what}`));
			}, 10_000).unref();
		}),
	]);
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

/** What a whole login run printed, and how it ended. */
type ObservedLogin = {
	readonly exitCode: number;
	/** Everything the command wrote — stdout and stderr lines together. */
	readonly output: string;
};

/**
 * Runs a whole real `login` against the stand-in WHOOP — the printed authorize
 * URL, the browser's trip back to the loopback redirect, the code exchange —
 * and captures every line it wrote on either stream, so a case can scan the
 * command's entire outward surface.
 */
async function observeLogin(env: {
	store: string;
	whoopBaseUrl: string;
}): Promise<ObservedLogin> {
	const redirectUri = await unusedRedirectUri();
	const lines: string[] = [];

	let announce: (url: URL) => void = () => {};
	const authorizeUrl = new Promise<URL>((resolve) => {
		announce = resolve;
	});

	const exitCode = runLogin({
		env: {
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: CLIENT_SECRET,
			WHOOP_REDIRECT_URI: redirectUri,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
			WHOOP_TOKEN_STORE: env.store,
		},
		print: (message) => {
			lines.push(message);
			const found = message.match(/https?:\/\/\S*\/oauth\/oauth2\/auth\S*/);
			if (found) {
				announce(new URL(found[0]));
			}
		},
		printFailure: (message) => {
			lines.push(message);
		},
		openBrowser: () => {},
	});

	// Play the browser arriving at the loopback redirect.
	const back = new URL(redirectUri);
	back.searchParams.set("code", AUTHORIZATION_CODE);
	back.searchParams.set(
		"state",
		(
			await within(authorizeUrl, "the authorize URL to be printed")
		).searchParams.get("state") ?? "",
	);
	await fetch(back);

	return {
		exitCode: await within(exitCode, "the login command to finish"),
		output: lines.join("\n"),
	};
}

/** A tool call's outcome plus everything its server wrote to stderr. */
type ObservedCall = {
	failed: boolean;
	/** The whole result (or rejection), serialized, for scanning. */
	resultText: string;
	stderrText: string;
};

/**
 * Spawns the built server — a separate process, exactly what an MCP host runs
 * — with its stderr piped, calls one tool, and reports both the full result
 * and everything the server said on stderr, so a case can scan every outward
 * surface of the call at once.
 */
async function observeToolCall(
	env: { store: string; whoopBaseUrl: string },
	name: string,
): Promise<ObservedCall> {
	const client = new Client({ name: "redaction-test", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: CLIENT_SECRET,
		},
		stderr: "pipe",
	});
	const stderrChunks: Buffer[] = [];
	transport.stderr?.on("data", (chunk: Buffer) => {
		stderrChunks.push(chunk);
	});

	await client.connect(transport);
	let failed: boolean;
	let resultText: string;
	try {
		const result = await client.callTool({ name, arguments: {} });
		failed = result.isError === true;
		resultText = JSON.stringify(result);
	} catch (error) {
		failed = true;
		resultText = String(error);
	} finally {
		await client.close();
	}

	return {
		failed,
		resultText,
		stderrText: Buffer.concat(stderrChunks).toString("utf8"),
	};
}

describe("token material never leaks", () => {
	it("keeps a refresh rejection that echoes the refresh token out of the tool error and stderr", async () => {
		const whoop = await startFakeWhoop({
			token: {
				status: 400,
				body: {
					error: "invalid_grant",
					error_description: `refresh token ${REFRESH_TOKEN} is revoked`,
					refresh_token: REFRESH_TOKEN,
				},
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: true });

		const call = await observeToolCall(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(call.failed).toBe(true);
		expect(call.resultText).not.toContain(REFRESH_TOKEN);
		expect(call.stderrText).not.toContain(REFRESH_TOKEN);
	}, 30_000);

	it("keeps every secret out of tool errors and stderr when WHOOP echoes them through the refresh and data paths", async () => {
		// A body WHOOP could answer either endpoint with, echoing every piece of
		// token material this server holds.
		const echoingBody = {
			error: "invalid_request",
			error_description: `access ${ACCESS_TOKEN} refresh ${REFRESH_TOKEN} secret ${CLIENT_SECRET}`,
			access_token: ACCESS_TOKEN,
			refresh_token: REFRESH_TOKEN,
			client_secret: CLIENT_SECRET,
		};

		// Refresh path: an expired login forces a refresh, and WHOOP rejects it
		// with the echoing body before any data request goes out.
		const refreshRejecting = await startFakeWhoop({
			token: { status: 400, body: echoingBody },
		});
		const expiredStore = await temporaryStore();
		await seedLogin(expiredStore, { expired: true });
		const viaRefresh = await observeToolCall(
			{ store: expiredStore, whoopBaseUrl: refreshRejecting.baseUrl },
			"get_profile",
		);

		// Data path: a login the store still trusts, and WHOOP failing the data
		// request itself with the echoing body.
		const dataFailing = await startFakeWhoop({
			profile: { status: 500, body: echoingBody },
		});
		const trustedStore = await temporaryStore();
		await seedLogin(trustedStore, { expired: false });
		const viaData = await observeToolCall(
			{ store: trustedStore, whoopBaseUrl: dataFailing.baseUrl },
			"get_profile",
		);

		for (const call of [viaRefresh, viaData]) {
			expect(call.failed).toBe(true);
			for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
				expect(call.resultText).not.toContain(secret);
				expect(call.stderrText).not.toContain(secret);
			}
		}
	}, 30_000);

	it("scrubs a long WHOOP error before capping it, keeping no token prefix", async () => {
		// A rejection long enough to be cut, with the access token sitting exactly
		// where the cut would fall: scrubbing only after cutting would leave the
		// first characters of a live token standing in the clear, and a boundary
		// the scrubber can no longer recognise is a boundary it cannot repair.
		const buried = `${"A".repeat(288)}${ACCESS_TOKEN}${"F".repeat(600)}`;
		const whoop = await startFakeWhoop({
			profile: { status: 400, body: { message: buried } },
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const call = await observeToolCall(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(call.failed).toBe(true);
		for (const surface of [call.resultText, call.stderrText]) {
			expect(surface).not.toContain(ACCESS_TOKEN);
			expect(surface).not.toContain(ACCESS_TOKEN.slice(0, 12));
			// Nothing of the 600 characters trailing the token survives the cap.
			expect(surface).not.toMatch(/F{301}/);
		}
		// Capping takes WHOOP's words, never the sentence built around them.
		expect(call.resultText).toContain("Retrying will not help.");
	}, 30_000);

	it("mirrors WHOOP's payload in a successful tool result without the bearer token", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 200,
				body: {
					user_id: 10_129,
					email: "ada@example.com",
					first_name: "Ada",
					last_name: "Lovelace",
				},
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const call = await observeToolCall(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(call.failed).toBe(false);
		// The payload is the point of the call; the token that fetched it is not
		// part of it.
		expect(call.resultText).toContain("ada@example.com");
		expect(call.resultText).not.toContain(ACCESS_TOKEN);
	}, 30_000);

	it("prints no token material on a successful login, only what the user may see", async () => {
		const whoop = await startFakeWhoop({
			token: {
				status: 200,
				body: {
					access_token: ACCESS_TOKEN,
					refresh_token: REFRESH_TOKEN,
					expires_in: 3600,
					scope: "read:profile offline",
					token_type: "bearer",
				},
			},
		});
		const store = await temporaryStore();

		const login = await observeLogin({ store, whoopBaseUrl: whoop.baseUrl });

		expect(login.exitCode).toBe(0);
		// The granted scopes are the user's to see; the tokens are not.
		expect(login.output).toContain("read:profile offline");
		expect(login.output).not.toContain(ACCESS_TOKEN);
		expect(login.output).not.toContain(REFRESH_TOKEN);
		expect(login.output).not.toContain(CLIENT_SECRET);
	}, 30_000);

	it("keeps the code and secret out of a failed login's output, even when WHOOP echoes them", async () => {
		const whoop = await startFakeWhoop({
			token: {
				status: 400,
				body: {
					error: "invalid_grant",
					error_description: `code ${AUTHORIZATION_CODE} for secret ${CLIENT_SECRET} was rejected`,
				},
			},
		});
		const store = await temporaryStore();

		const login = await observeLogin({ store, whoopBaseUrl: whoop.baseUrl });

		expect(login.exitCode).not.toBe(0);
		expect(login.output).not.toContain(AUTHORIZATION_CODE);
		expect(login.output).not.toContain(CLIENT_SECRET);
	}, 30_000);
});

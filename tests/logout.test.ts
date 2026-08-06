import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { writeStoredTokens } from "@/auth/tokens/store";

const run = promisify(execFile);

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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-logout-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

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

/** One canned answer the stand-in WHOOP's token endpoint gives. */
type TokenAnswer = {
	status: number;
	body: unknown;
};

/**
 * A stand-in WHOOP that records every request and answers each with the given
 * status — 204 plays a WHOOP that revoked, 500 one that fell over. The token
 * endpoint is scripted apart from the revocation, since a logout that finds an
 * expired login asks this same WHOOP two different questions.
 */
async function startFakeWhoop(
	status = 204,
	token?: TokenAnswer,
): Promise<FakeWhoop> {
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
			if (token && path === "/oauth/oauth2/token") {
				response.writeHead(token.status, {
					"content-type": "application/json",
					connection: "close",
				});
				response.end(JSON.stringify(token.body));

				return;
			}
			response.writeHead(status, { connection: "close" });
			response.end();
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/** The tokens a completed login would have left behind. */
const SEEDED_TOKENS = {
	accessToken: "an-access-token",
	refreshToken: "a-refresh-token",
	expiresAt: Date.now() + 3_600_000,
	scopes: ["read:profile", "offline"],
};

/**
 * A login whose access token expired an hour ago, carrying the application
 * credentials a refresh has to authenticate as. Every secret is spelled
 * distinctively so a case can tell whether any of them reached the terminal.
 */
const EXPIRED_TOKENS = {
	accessToken: "stored-access-token-aaaa",
	refreshToken: "stored-refresh-token-bbbb",
	expiresAt: Date.now() - 3_600_000,
	scopes: ["read:profile", "offline"],
	application: {
		clientId: "a-client-id",
		clientSecret: "a-client-secret-cccc",
	},
};

/** What the scripted token endpoint hands back when it honors the refresh. */
const ROTATED_TOKENS = {
	access_token: "rotated-access-token-dddd",
	refresh_token: "rotated-refresh-token-eeee",
	expires_in: 3600,
	scope: "read:profile offline",
};

/**
 * Fails when anything the logout printed carries secret material: the pair the
 * store held, the pair WHOOP rotated to, or the secret that signed the refresh.
 * None of them has any business on a terminal.
 */
function expectNoTokenMaterial(output: string): void {
	for (const secret of [
		EXPIRED_TOKENS.accessToken,
		EXPIRED_TOKENS.refreshToken,
		EXPIRED_TOKENS.application.clientSecret,
		ROTATED_TOKENS.access_token,
		ROTATED_TOKENS.refresh_token,
	]) {
		expect(output).not.toContain(secret);
	}
}

/**
 * Runs the built CLI's `logout` the way a user would — a real child process,
 * pointed at the given token store and stand-in WHOOP — and reports how it
 * ended. Both streams come back as one string, since the assertions care that
 * the user was told something, not which pipe carried it.
 */
async function runLogout(env: {
	store: string;
	whoopBaseUrl: string;
}): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			[builtEntry, "logout"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					WHOOP_TOKEN_STORE: env.store,
					WHOOP_API_BASE_URL: env.whoopBaseUrl,
				},
			},
		);

		return { code: 0, output: stdout + stderr };
	} catch (error) {
		const failure = error as {
			code?: number;
			stdout?: string;
			stderr?: string;
		};

		return {
			code: failure.code ?? 1,
			output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
		};
	}
}

/**
 * Serves `get_profile` from a *fresh* server process — a real MCP client over
 * stdio, the way an MCP host would after the logout — and reduces the two
 * shapes a failure can take to one record, so a case can assert on the failure
 * text without pinning down which shape the SDK chose.
 */
async function serveGetProfile(env: {
	store: string;
	whoopBaseUrl: string;
}): Promise<{ failed: boolean; text: string }> {
	const client = new Client({ name: "logout-test", version: "0.0.0" });
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
		const result = await client.callTool({
			name: "get_profile",
			arguments: {},
		});

		return {
			failed: result.isError === true,
			text: JSON.stringify(result.content),
		};
	} catch (error) {
		return { failed: true, text: String(error) };
	} finally {
		await client.close();
	}
}

describe("the logout command", () => {
	it("revokes upstream with the bearer token, deletes the store, and confirms", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await writeStoredTokens(SEEDED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const { code, output } = await runLogout({
			store,
			whoopBaseUrl: whoop.baseUrl,
		});

		expect(whoop.requests).toContainEqual({
			method: "DELETE",
			path: "/developer/v2/user/access",
			authorization: "Bearer an-access-token",
		});
		// A login the store still trusts is revoked with exactly the token it
		// holds: nothing here is worth spending a refresh token on.
		expect(
			whoop.requests.some((request) => request.path === "/oauth/oauth2/token"),
		).toBe(false);
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
		expect(code).toBe(0);
		expect(output).toMatch(/logged out/i);
	}, 30_000);

	it("refreshes an expired login and revokes with the token that comes back", async () => {
		const whoop = await startFakeWhoop(204, {
			status: 200,
			body: ROTATED_TOKENS,
		});
		const store = await temporaryStore();
		await writeStoredTokens(EXPIRED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const { code, output } = await runLogout({
			store,
			whoopBaseUrl: whoop.baseUrl,
		});

		// One refresh, and then the revocation it was spent on: a dead bearer is
		// all WHOOP would have seen without it.
		expect(
			whoop.requests.map((request) => `${request.method} ${request.path}`),
		).toEqual(["POST /oauth/oauth2/token", "DELETE /developer/v2/user/access"]);
		expect(whoop.requests).toContainEqual({
			method: "DELETE",
			path: "/developer/v2/user/access",
			authorization: `Bearer ${ROTATED_TOKENS.access_token}`,
		});
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
		expect(code).toBe(0);
		expect(output).toMatch(/logged out/i);
		expectNoTokenMaterial(output);
	}, 30_000);

	it("still revokes with the stored token when the refresh is refused", async () => {
		const whoop = await startFakeWhoop(401, {
			status: 400,
			body: {
				error: "invalid_grant",
				// WHOOP's refusals quote what they refused, so this one carries the
				// refresh token straight back into the process.
				error_description: `refresh token ${EXPIRED_TOKENS.refreshToken} is not acceptable`,
			},
		});
		const store = await temporaryStore();
		await writeStoredTokens(EXPIRED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const { code, output } = await runLogout({
			store,
			whoopBaseUrl: whoop.baseUrl,
		});

		// The stored token is the best one held once the refresh fails, and an
		// unlikely revocation still beats no revocation at all.
		expect(whoop.requests).toContainEqual({
			method: "DELETE",
			path: "/developer/v2/user/access",
			authorization: `Bearer ${EXPIRED_TOKENS.accessToken}`,
		});
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
		expect(code).toBe(0);
		expect(output).toMatch(/warning/i);
		expect(output).toMatch(/may still be granted upstream/i);
		expectNoTokenMaterial(output);
	}, 30_000);

	it("still deletes the store and exits 0 with a warning when the revoke answers 500", async () => {
		const whoop = await startFakeWhoop(500);
		const store = await temporaryStore();
		await writeStoredTokens(SEEDED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const { code, output } = await runLogout({
			store,
			whoopBaseUrl: whoop.baseUrl,
		});

		expect(existsSync(join(store, "tokens.json"))).toBe(false);
		expect(code).toBe(0);
		expect(output).toMatch(/warning/i);
		expect(output).toMatch(/may still be granted upstream/i);
	}, 30_000);

	it("exits 0 saying there is nothing to log out when nothing is stored", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { code, output } = await runLogout({
			store,
			whoopBaseUrl: whoop.baseUrl,
		});

		expect(code).toBe(0);
		expect(output).toMatch(/nothing to log out/i);
		expect(whoop.requests).toEqual([]);
	}, 30_000);

	it("leaves a fresh server refusing get_profile with the login command", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await writeStoredTokens(SEEDED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		expect((await runLogout({ store, whoopBaseUrl: whoop.baseUrl })).code).toBe(
			0,
		);

		const outcome = await serveGetProfile({
			store,
			whoopBaseUrl: whoop.baseUrl,
		});

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("npx mcp-whoop login");
	}, 30_000);
});

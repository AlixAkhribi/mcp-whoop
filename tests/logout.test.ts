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

/**
 * A stand-in WHOOP that records every request and answers each with the given
 * status — 204 plays a WHOOP that revoked, 500 one that fell over.
 */
async function startFakeWhoop(status = 204): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		requests.push({
			method: request.method ?? "",
			path: new URL(request.url ?? "/", "http://whoop.invalid").pathname,
			authorization: request.headers.authorization,
		});
		request.resume();
		request.on("end", () => {
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
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
		expect(code).toBe(0);
		expect(output).toMatch(/logged out/i);
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

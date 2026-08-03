import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-taxonomy-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** One canned answer a stand-in WHOOP endpoint gives, headers included. */
type Answer = {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
};

/**
 * A stand-in WHOOP whose answers a case scripts per endpoint: rate limits with
 * a Retry-After, outages, and client errors carrying WHOOP's own message.
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
				...answer?.headers,
			});
			response.end(JSON.stringify(answer?.body ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server) };
}

/** A base URL whose port was just released, so nothing answers on it. */
async function closedPortBaseUrl(): Promise<string> {
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

	return `http://127.0.0.1:${port}`;
}

/** Seeds the store with a login, either still trusted or already expired. */
async function seedLogin(
	store: string,
	options: { expired: boolean },
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + (options.expired ? -60_000 : 3_600_000),
			scopes: ["read:profile", "offline"],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * Calls one tool on the built server over real stdio — a separate process,
 * exactly what an MCP host spawns — and reduces the two shapes a failure can
 * take to one record, so a case can assert on the failure text alone.
 */
async function callTool(
	env: { store: string; whoopBaseUrl: string },
	name: string,
): Promise<{ failed: boolean; text: string }> {
	const client = new Client({ name: "error-taxonomy-test", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: "a-client-secret",
		},
	});

	await client.connect(transport);
	try {
		const result = await client.callTool({ name, arguments: {} });

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

describe("the error taxonomy at the tool boundary, over real stdio", () => {
	it("marks a 429 with Retry-After as rate-limited and retryable, naming the wait", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 429,
				body: { error: "too_many_requests" },
				headers: { "retry-after": "30" },
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/rate-limited/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		expect(outcome.text).toContain("30 seconds");
	}, 30_000);

	it("marks a 503 as retryable, naming a temporary WHOOP outage", async () => {
		const whoop = await startFakeWhoop({
			profile: { status: 503, body: { error: "service_unavailable" } },
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/temporar/i);
		expect(outcome.text).toMatch(/outage/i);
		expect(outcome.text).toMatch(/safe to retry/i);
	}, 30_000);

	it("marks a WHOOP that cannot be reached as a retryable network failure", async () => {
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: await closedPortBaseUrl() },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/network/i);
		expect(outcome.text).toMatch(/safe to retry/i);
	}, 30_000);

	it("marks a 400 as fatal, carrying WHOOP's own message", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 400,
				body: {
					error: "invalid_request",
					message: "Query param start must be before end",
				},
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("Query param start must be before end");
		expect(outcome.text).toMatch(/will not help/i);
		expect(outcome.text).not.toMatch(/safe to retry/i);
	}, 30_000);

	it("marks a 429 during token refresh as rate-limited, not as a dead login", async () => {
		const whoop = await startFakeWhoop({
			token: {
				status: 429,
				body: { error: "too_many_requests" },
				headers: { "retry-after": "30" },
			},
		});
		const store = await temporaryStore();
		// An expired login forces the refresh before any data request goes out,
		// so the rate limit lands on the refresh path itself.
		await seedLogin(store, { expired: true });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/rate-limited/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		expect(outcome.text).not.toContain("no longer valid");
		expect(outcome.text).not.toContain("npx mcp-whoop login");
	}, 30_000);
});

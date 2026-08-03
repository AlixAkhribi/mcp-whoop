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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-scoped-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** The measurements the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const MEASUREMENTS = {
	height_meter: 1.65,
	weight_kilogram: 57.6,
	max_heart_rate: 198,
};

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

/** How the stand-in WHOOP answers each data path it knows. */
const ANSWERS: Record<string, unknown> = {
	"/developer/v2/user/measurement/body": MEASUREMENTS,
	"/developer/v2/user/profile/basic": PROFILE,
};

/**
 * A stand-in WHOOP serving the v2 data endpoints and recording every request,
 * so a case can assert what was actually sent upstream.
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

/** Every read scope WHOOP defines — what a default login is granted. */
const ALL_READ_SCOPES = [
	"read:profile",
	"read:body_measurement",
	"read:cycles",
	"read:sleep",
	"read:recovery",
	"read:workout",
];

/** Seeds a store with a live login that was granted the given scopes. */
async function seedStore(store: string, scopes: string[]): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes,
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

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
		name: "scoped-tools-stdio-test",
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

describe("granted scopes shaping the tool surface, over real stdio", () => {
	it("serves body measurements as structured content when every scope was granted", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const { names, result } = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				names: (await client.listTools()).tools.map((tool) => tool.name),
				result: await client.callTool({
					name: "get_body_measurements",
					arguments: {},
				}),
			}),
		);

		expect(names).toContain("get_body_measurements");
		expect(whoop.requests).toContainEqual({
			method: "GET",
			path: "/developer/v2/user/measurement/body",
			authorization: "Bearer an-access-token",
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(MEASUREMENTS);
	}, 30_000);

	it("hides get_body_measurements when its scope was not granted, keeping get_profile", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ["read:profile", "offline"]);

		const names = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => (await client.listTools()).tools.map((t) => t.name),
		);

		expect(names).not.toContain("get_body_measurements");
		expect(names).toContain("get_profile");
	}, 30_000);

	it("hides get_profile when read:profile was not granted", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ["read:body_measurement", "offline"]);

		const names = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => (await client.listTools()).tools.map((t) => t.name),
		);

		expect(names).not.toContain("get_profile");
		expect(names).toContain("get_body_measurements");
	}, 30_000);

	it("serves the full default surface when never logged in, and calls fail with the login command", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { names, outcomes } = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				names: (await client.listTools()).tools.map((t) => t.name),
				outcomes: await Promise.all(
					["get_profile", "get_body_measurements"].map((name) =>
						client
							.callTool({ name, arguments: {} })
							.then((result) => ({
								failed: result.isError === true,
								text: JSON.stringify(result.content),
							}))
							.catch((error: unknown) => ({
								failed: true,
								text: String(error),
							})),
					),
				),
			}),
		);

		expect(names).toContain("get_profile");
		expect(names).toContain("get_body_measurements");
		for (const outcome of outcomes) {
			expect(outcome.failed).toBe(true);
			expect(outcome.text).toContain("npx mcp-whoop login");
		}
	}, 30_000);
});

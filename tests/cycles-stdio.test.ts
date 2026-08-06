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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-cycles-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** The token the stand-in WHOOP's first page names for the second one. */
const SECOND_PAGE_TOKEN = "MTIzOjEyMzEyMw";

/**
 * The newest cycle in WHOOP's own v2 shape: still open, the way the real
 * newest cycle always is — `end: null`, an explicit null rather than an absent
 * field (observed 2026-08-02) — and already scored while it runs.
 */
const OPEN_CYCLE = {
	id: 93_845,
	user_id: 10_129,
	created_at: "2022-04-24T11:25:44.774Z",
	updated_at: "2022-04-24T14:25:44.774Z",
	start: "2022-04-24T02:25:44.774Z",
	end: null,
	timezone_offset: "-05:00",
	score_state: "SCORED",
	score: {
		strain: 5.2951527,
		kilojoule: 8288.297,
		average_heart_rate: 68,
		max_heart_rate: 141,
	},
};

/** The day-older, closed cycle the stand-in serves as its last page. */
const OLDER_CYCLE = {
	...OPEN_CYCLE,
	id: 93_844,
	created_at: "2022-04-23T11:25:44.774Z",
	updated_at: "2022-04-23T14:25:44.774Z",
	start: "2022-04-23T02:25:44.774Z",
	end: "2022-04-24T02:25:44.774Z",
};

/** One request the stand-in WHOOP was asked to serve. */
type WhoopRequest = {
	method: string;
	path: string;
	query: Record<string, string>;
	authorization: string | undefined;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * How the stand-in WHOOP answers a cycles request: two pages behind the
 * collection, the second reached only through {@link SECOND_PAGE_TOKEN} and
 * naming its end the way the real WHOOP does — an explicit `next_token: null`;
 * one known cycle by id, and 404 for every other id, exactly as WHOOP answers
 * an id it does not have.
 */
function answerFor(url: URL): unknown {
	if (url.pathname === "/developer/v2/cycle") {
		return url.searchParams.get("nextToken") === SECOND_PAGE_TOKEN
			? { records: [OLDER_CYCLE], next_token: null }
			: { records: [OPEN_CYCLE], next_token: SECOND_PAGE_TOKEN };
	}
	if (url.pathname === `/developer/v2/cycle/${OPEN_CYCLE.id}`) {
		return OPEN_CYCLE;
	}

	return undefined;
}

/** One canned answer a case scripts the collection with, headers included. */
type Answer = {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
};

/**
 * A stand-in WHOOP serving the v2 cycle collection and recording every request
 * — query string included — so a case can assert what was actually sent
 * upstream. `collection` overrides the pages above with one scripted answer.
 */
async function startFakeWhoop(
	options: { collection?: Answer } = {},
): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		requests.push({
			method: request.method ?? "",
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: request.headers.authorization,
		});
		request.resume();
		request.on("end", () => {
			const scripted =
				url.pathname === "/developer/v2/cycle" ? options.collection : undefined;
			if (scripted) {
				response.writeHead(scripted.status, {
					"content-type": "application/json",
					connection: "close",
					...scripted.headers,
				});
				response.end(JSON.stringify(scripted.body));

				return;
			}

			const answer = answerFor(url);
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
	const client = new Client({ name: "cycles-stdio-test", version: "0.0.0" });
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

/**
 * Calls a tool and reduces the two shapes a failure can take — a rejected
 * promise or a resolved `isError` result — to one record, so a case can assert
 * on the failure text without pinning down which shape the SDK chose.
 */
async function callToolOutcome(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ failed: boolean; text: string }> {
	try {
		const result = await client.callTool({ name, arguments: args });

		return {
			failed: result.isError === true,
			text: JSON.stringify(result.content),
		};
	} catch (error) {
		return { failed: true, text: String(error) };
	}
}

describe("the cycle tools over real stdio", () => {
	it("mirrors WHOOP's first page verbatim, explicit nulls included", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "list_cycles", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/developer/v2/cycle",
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual({
			records: [OPEN_CYCLE],
			next_token: SECOND_PAGE_TOKEN,
		});
	}, 30_000);

	it("relays nextToken and limit verbatim, and ends on an explicit next_token: null", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const lastPage = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "list_cycles",
					arguments: { nextToken: SECOND_PAGE_TOKEN, limit: 5 },
				}),
		);

		expect(lastPage.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				path: "/developer/v2/cycle",
				query: { nextToken: SECOND_PAGE_TOKEN, limit: "5" },
			}),
		);
		// The last page names its end the way the real WHOOP does: an explicit
		// `next_token: null`, not an absent field.
		expect(lastPage.structuredContent).toEqual({
			records: [OLDER_CYCLE],
			next_token: null,
		});
	}, 30_000);

	it("advertises list_cycles with a description and WHOOP's own query arguments", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const { tools } = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.listTools(),
		);

		const tool = tools.find((candidate) => candidate.name === "list_cycles");
		expect(tool?.description).toEqual(expect.any(String));
		expect(tool?.description).not.toBe("");
		expect(tool?.inputSchema.type).toBe("object");
		// A schema emptied by a top-level refinement would still be an object;
		// the advertised properties are what a model actually reads.
		expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
			"end",
			"limit",
			"nextToken",
			"start",
		]);
	}, 30_000);

	it("hides list_cycles when read:cycles was not granted, keeping get_profile", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ["read:profile", "offline"]);

		const names = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => (await client.listTools()).tools.map((t) => t.name),
		);

		expect(names).not.toContain("list_cycles");
		expect(names).toContain("get_profile");
	}, 30_000);

	it("reads one cycle by id, mirroring WHOOP's record verbatim", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "get_cycle",
					arguments: { cycleId: OPEN_CYCLE.id },
				}),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: `/developer/v2/cycle/${OPEN_CYCLE.id}`,
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual(OPEN_CYCLE);
	}, 30_000);

	it("says the cycle was not found when WHOOP answers 404, suggesting no retry", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);
		const missingId = 404_404;

		const outcome = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => callToolOutcome(client, "get_cycle", { cycleId: missingId }),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/not found/i);
		expect(outcome.text).toContain(`${missingId}`);
		expect(outcome.text).not.toMatch(/retry/i);
	}, 30_000);

	it("hides get_cycle when read:cycles was not granted, keeping get_profile", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ["read:profile", "offline"]);

		const names = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => (await client.listTools()).tools.map((t) => t.name),
		);

		expect(names).not.toContain("get_cycle");
		expect(names).toContain("get_profile");
	}, 30_000);

	it("marks a rate-limited cycles read as retryable, naming the wait", async () => {
		const whoop = await startFakeWhoop({
			collection: {
				status: 429,
				body: { error: "too_many_requests" },
				headers: { "retry-after": "30" },
			},
		});
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const outcome = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => callToolOutcome(client, "list_cycles", {}),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/rate-limited/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		expect(outcome.text).toContain("30 seconds");
	}, 30_000);
});

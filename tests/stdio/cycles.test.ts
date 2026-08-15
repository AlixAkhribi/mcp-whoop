import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	callToolOutcome,
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

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

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP.
 */

describe("the cycle tools over real stdio", () => {
	it("mirrors WHOOP's first page verbatim, explicit nulls included", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
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
	});

	it("relays nextToken and limit verbatim, and ends on an explicit next_token: null", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const lastPage = await withBuiltStdioClient(
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
	});

	it("advertises list_cycles with a description and WHOOP's own query arguments", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { tools } = await withBuiltStdioClient(
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
	});

	it("reads one cycle by id, mirroring WHOOP's record verbatim", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
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
	});

	it("says the cycle was not found when WHOOP answers 404, suggesting no retry", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);
		const missingId = 404_404;

		const outcome = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => callToolOutcome(client, "get_cycle", { cycleId: missingId }),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/not found/i);
		expect(outcome.text).toContain(`${missingId}`);
		expect(outcome.text).not.toMatch(/retry/i);
	});
});

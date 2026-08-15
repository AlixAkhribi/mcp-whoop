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
 * A scored recovery in WHOOP's own v2 shape, keyed by the cycle it scores and
 * the sleep it was computed from, with the blood-oxygen and skin-temperature
 * readings hardware that measures them reports.
 */
const SCORED_RECOVERY = {
	cycle_id: 93_845,
	sleep_id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
	user_id: 10_129,
	created_at: "2022-04-24T11:25:44.774Z",
	updated_at: "2022-04-24T14:25:44.774Z",
	score_state: "SCORED",
	score: {
		user_calibrating: false,
		recovery_score: 44,
		resting_heart_rate: 64,
		hrv_rmssd_milli: 31.813_562,
		spo2_percentage: 95.6875,
		skin_temp_celsius: 33.7,
	},
};

/**
 * A recovery WHOOP has not scored yet: `score: null`, an explicit null rather
 * than an absent field (observed 2026-08-02), until `score_state` reaches
 * `SCORED`.
 */
const PENDING_RECOVERY = {
	cycle_id: 93_846,
	sleep_id: "d1c4b1a0-6d9b-4a0e-9a1e-1b6b0a6f2f4c",
	user_id: 10_129,
	created_at: "2022-04-25T11:25:44.774Z",
	updated_at: "2022-04-25T11:25:44.774Z",
	score_state: "PENDING_SCORE",
	score: null,
};

/**
 * The day-older recovery the stand-in serves as its last page, scored on
 * hardware that measures neither blood oxygen nor skin temperature — nulls
 * WHOOP sends explicitly rather than omitting.
 */
const OLDER_RECOVERY = {
	...SCORED_RECOVERY,
	cycle_id: 93_844,
	sleep_id: "b0f0f2ba-0b52-4a0e-8d0a-6c0d1c9f7a3b",
	created_at: "2022-04-23T11:25:44.774Z",
	updated_at: "2022-04-23T14:25:44.774Z",
	score: {
		...SCORED_RECOVERY.score,
		spo2_percentage: null,
		skin_temp_celsius: null,
	},
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
 * How the stand-in WHOOP answers a recoveries request: two pages behind the
 * collection, the second reached only through {@link SECOND_PAGE_TOKEN}; one
 * recovery under the id of the cycle it scores, and 404 for every other cycle
 * id, exactly as WHOOP answers a cycle it has not scored a recovery for.
 */
function answerFor(url: URL): unknown {
	if (url.pathname === "/developer/v2/recovery") {
		return url.searchParams.get("nextToken") === SECOND_PAGE_TOKEN
			? { records: [OLDER_RECOVERY], next_token: null }
			: {
					records: [PENDING_RECOVERY, SCORED_RECOVERY],
					next_token: SECOND_PAGE_TOKEN,
				};
	}
	if (
		url.pathname === `/developer/v2/cycle/${SCORED_RECOVERY.cycle_id}/recovery`
	) {
		return SCORED_RECOVERY;
	}

	return undefined;
}

/**
 * A stand-in WHOOP serving the v2 recovery collection and recording every
 * request — query string included — so a case can assert what was actually
 * sent upstream.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
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

describe("the recovery tools over real stdio", () => {
	it("mirrors WHOOP's page verbatim, an unscored score: null included", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "list_recoveries", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/developer/v2/recovery",
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual({
			records: [PENDING_RECOVERY, SCORED_RECOVERY],
			next_token: SECOND_PAGE_TOKEN,
		});
	});

	it("relays nextToken verbatim, and ends on an explicit next_token: null", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const lastPage = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "list_recoveries",
					arguments: { nextToken: SECOND_PAGE_TOKEN, limit: 5 },
				}),
		);

		expect(lastPage.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				path: "/developer/v2/recovery",
				query: { nextToken: SECOND_PAGE_TOKEN, limit: "5" },
			}),
		);
		// The last page names its end the way the real WHOOP does: an explicit
		// `next_token: null`, not an absent field.
		expect(lastPage.structuredContent).toEqual({
			records: [OLDER_RECOVERY],
			next_token: null,
		});
	});

	it("reads the recovery scored for a cycle, mirroring WHOOP's record verbatim", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "get_cycle_recovery",
					arguments: { cycleId: SCORED_RECOVERY.cycle_id },
				}),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: `/developer/v2/cycle/${SCORED_RECOVERY.cycle_id}/recovery`,
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual(SCORED_RECOVERY);
	});

	it("says the cycle has no recovery yet when the join answers 404", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);
		const unscoredCycleId = 404_404;

		const outcome = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				callToolOutcome(client, "get_cycle_recovery", {
					cycleId: unscoredCycleId,
				}),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain(`${unscoredCycleId}`);
		expect(outcome.text).toMatch(/no recovery/i);
		expect(outcome.text).toMatch(/yet/i);
	});
});

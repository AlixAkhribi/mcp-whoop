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
 * A scored run in WHOOP's own v2 shape: a record born on v2, so `v1_id` is an
 * explicit null (observed 2026-08-02), carrying the sport WHOOP recognised it
 * as and the distance and altitude a run records.
 */
const SCORED_RUN = {
	id: "1b7bd44c-cbde-4d4d-b476-3c95bdf37b46",
	v1_id: null,
	user_id: 10_129,
	created_at: "2022-04-24T11:25:44.774Z",
	updated_at: "2022-04-24T14:25:44.774Z",
	start: "2022-04-24T02:25:44.774Z",
	end: "2022-04-24T03:25:44.774Z",
	timezone_offset: "-05:00",
	sport_name: "running",
	sport_id: 0,
	score_state: "SCORED",
	score: {
		strain: 8.246_3,
		average_heart_rate: 123,
		max_heart_rate: 146,
		kilojoule: 1_569.340_33,
		percent_recorded: 100,
		distance_meter: 1_772.770_35,
		altitude_gain_meter: 46.643_84,
		altitude_change_meter: -0.781_372,
		zone_durations: {
			zone_zero_milli: 13_458,
			zone_one_milli: 389_370,
			zone_two_milli: 388_367,
			zone_three_milli: 71_137,
			zone_four_milli: 0,
			zone_five_milli: 0,
		},
	},
};

/**
 * A plain "activity" — the sport WHOOP files anything it cannot name under,
 * `sport_id: -1` — recording no distance and no altitude, which WHOOP reports
 * as explicit nulls rather than absent fields (observed 2026-08-02).
 */
const PLAIN_ACTIVITY = {
	...SCORED_RUN,
	id: "d1c4b1a0-6d9b-4a0e-9a1e-1b6b0a6f2f4c",
	created_at: "2022-04-24T20:25:44.774Z",
	updated_at: "2022-04-24T21:25:44.774Z",
	start: "2022-04-24T19:25:44.774Z",
	end: "2022-04-24T20:10:44.774Z",
	sport_name: "activity",
	sport_id: -1,
	score: {
		...SCORED_RUN.score,
		distance_meter: null,
		altitude_gain_meter: null,
		altitude_change_meter: null,
	},
};

/**
 * The day-older workout, carried on a record that predates v2 — so `v1_id`
 * holds the id WHOOP's v1 knew it by. The stand-in serves it as its last page.
 */
const OLDER_WORKOUT = {
	...SCORED_RUN,
	id: "0e8f9c14-9e2b-4d67-bd35-1c1a5f6c2b7d",
	v1_id: 1_042,
	created_at: "2022-04-23T11:25:44.774Z",
	updated_at: "2022-04-23T14:25:44.774Z",
	start: "2022-04-23T02:25:44.774Z",
	end: "2022-04-23T03:25:44.774Z",
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
 * How the stand-in WHOOP answers a workouts request: two pages behind the
 * collection, the second reached only through {@link SECOND_PAGE_TOKEN}; one
 * known workout by id, and 404 for every other id, exactly as WHOOP answers an
 * id it does not have.
 */
function answerFor(url: URL): unknown {
	if (url.pathname === "/developer/v2/activity/workout") {
		return url.searchParams.get("nextToken") === SECOND_PAGE_TOKEN
			? { records: [OLDER_WORKOUT], next_token: null }
			: {
					records: [PLAIN_ACTIVITY, SCORED_RUN],
					next_token: SECOND_PAGE_TOKEN,
				};
	}
	if (url.pathname === `/developer/v2/activity/workout/${SCORED_RUN.id}`) {
		return SCORED_RUN;
	}

	return undefined;
}

/**
 * A stand-in WHOOP serving the v2 workout collection and recording every
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

describe("the workout tools over real stdio", () => {
	it("mirrors WHOOP's page verbatim, a sport's nulls intact", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "list_workouts", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/developer/v2/activity/workout",
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual({
			records: [PLAIN_ACTIVITY, SCORED_RUN],
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
					name: "list_workouts",
					arguments: { nextToken: SECOND_PAGE_TOKEN, limit: 5 },
				}),
		);

		expect(lastPage.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				path: "/developer/v2/activity/workout",
				query: { nextToken: SECOND_PAGE_TOKEN, limit: "5" },
			}),
		);
		// The last page names its end the way the real WHOOP does: an explicit
		// `next_token: null`, not an absent field.
		expect(lastPage.structuredContent).toEqual({
			records: [OLDER_WORKOUT],
			next_token: null,
		});
	});

	it("reads one workout by id, mirroring WHOOP's record verbatim", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "get_workout",
					arguments: { workoutId: SCORED_RUN.id },
				}),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: `/developer/v2/activity/workout/${SCORED_RUN.id}`,
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual(SCORED_RUN);
	});

	it("says the workout was not found when WHOOP answers 404, suggesting no retry", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);
		const missingId = "00000000-0000-4000-8000-000000000404";

		const outcome = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				callToolOutcome(client, "get_workout", { workoutId: missingId }),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/not found/i);
		expect(outcome.text).toContain(missingId);
		expect(outcome.text).not.toMatch(/retry/i);
	});
});

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
 * The physiological cycle {@link SCORED_NIGHT} started: WHOOP joins a cycle to
 * the sleep that begins it, addressed by the cycle's own integer id — the same
 * id the sleep names back as its `cycle_id`.
 */
const ONSET_CYCLE_ID = 93_845;

/**
 * A scored night in WHOOP's own v2 shape: a record born on v2, so `v1_id` is
 * an explicit null (observed 2026-08-02), carrying the cycle it belongs to, the
 * stage summary and the sleep-needed breakdown WHOOP computes for it.
 */
const SCORED_NIGHT = {
	id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
	cycle_id: ONSET_CYCLE_ID,
	v1_id: null,
	user_id: 10_129,
	created_at: "2022-04-24T11:25:44.774Z",
	updated_at: "2022-04-24T14:25:44.774Z",
	start: "2022-04-24T02:25:44.774Z",
	end: "2022-04-24T10:25:44.774Z",
	timezone_offset: "-05:00",
	nap: false,
	score_state: "SCORED",
	score: {
		stage_summary: {
			total_in_bed_time_milli: 30_272_735,
			total_awake_time_milli: 1_403_507,
			total_no_data_time_milli: 0,
			total_light_sleep_time_milli: 14_780_051,
			total_slow_wave_sleep_time_milli: 6_777_400,
			total_rem_sleep_time_milli: 5_720_294,
			sleep_cycle_count: 3,
			disturbance_count: 12,
		},
		sleep_needed: {
			baseline_milli: 27_395_716,
			need_from_sleep_debt_milli: 352_230,
			need_from_recent_strain_milli: 208_595,
			need_from_recent_nap_milli: -12_312,
		},
		respiratory_rate: 16.113_281_25,
		sleep_performance_percentage: 98,
		sleep_consistency_percentage: 90,
		sleep_efficiency_percentage: 91.695_33,
	},
};

/**
 * An afternoon nap: `nap: true`, and short enough that WHOOP has no
 * consistency or performance to speak of — explicit nulls rather than absent
 * fields (observed 2026-08-02).
 */
const NAP = {
	...SCORED_NIGHT,
	id: "d1c4b1a0-6d9b-4a0e-9a1e-1b6b0a6f2f4c",
	created_at: "2022-04-24T20:25:44.774Z",
	updated_at: "2022-04-24T21:25:44.774Z",
	start: "2022-04-24T19:25:44.774Z",
	end: "2022-04-24T20:10:44.774Z",
	nap: true,
	score: {
		...SCORED_NIGHT.score,
		stage_summary: {
			total_in_bed_time_milli: 2_700_000,
			total_awake_time_milli: 120_000,
			total_no_data_time_milli: 0,
			total_light_sleep_time_milli: 1_980_000,
			total_slow_wave_sleep_time_milli: 600_000,
			total_rem_sleep_time_milli: 0,
			sleep_cycle_count: 1,
			disturbance_count: 2,
		},
		sleep_performance_percentage: null,
		sleep_consistency_percentage: null,
		sleep_efficiency_percentage: null,
	},
};

/**
 * The night before, carried on a record that predates v2 — so `v1_id` holds
 * the id WHOOP's v1 knew it by, and its `cycle_id` is the cycle before the one
 * {@link SCORED_NIGHT} started. The stand-in serves it as its last page.
 */
const OLDER_NIGHT = {
	...SCORED_NIGHT,
	id: "b0f0f2ba-0b52-4a0e-8d0a-6c0d1c9f7a3b",
	cycle_id: ONSET_CYCLE_ID - 1,
	v1_id: 93_844,
	created_at: "2022-04-23T11:25:44.774Z",
	updated_at: "2022-04-23T14:25:44.774Z",
	start: "2022-04-23T02:25:44.774Z",
	end: "2022-04-23T10:25:44.774Z",
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
 * How the stand-in WHOOP answers a sleeps request: two pages behind the
 * collection, the second reached only through {@link SECOND_PAGE_TOKEN}; one
 * known sleep by id, one sleep under the cycle it started, and 404 for every
 * other id, exactly as WHOOP answers an id it does not have.
 */
function answerFor(url: URL): unknown {
	if (url.pathname === "/developer/v2/activity/sleep") {
		return url.searchParams.get("nextToken") === SECOND_PAGE_TOKEN
			? { records: [OLDER_NIGHT], next_token: null }
			: {
					records: [NAP, SCORED_NIGHT],
					next_token: SECOND_PAGE_TOKEN,
				};
	}
	if (url.pathname === `/developer/v2/activity/sleep/${SCORED_NIGHT.id}`) {
		return SCORED_NIGHT;
	}
	if (url.pathname === `/developer/v2/cycle/${ONSET_CYCLE_ID}/sleep`) {
		return SCORED_NIGHT;
	}

	return undefined;
}

/**
 * A stand-in WHOOP serving the v2 sleep collection and recording every
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

/**
 * The sleep record a page-returning tool declares, read off its advertised
 * output schema the way a client reads it: the fields it names and the ones it
 * insists on.
 */
function declaredSleepRecord(outputSchema: unknown): {
	properties: Record<string, unknown>;
	required: string[];
} {
	const page = outputSchema as {
		properties?: {
			records?: {
				items?: { properties?: Record<string, unknown>; required?: string[] };
			};
		};
	};
	const record = page.properties?.records?.items;

	return {
		properties: record?.properties ?? {},
		required: record?.required ?? [],
	};
}

describe("the sleep tools over real stdio", () => {
	it("mirrors WHOOP's page verbatim, a night and a nap alike", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "list_sleeps", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/developer/v2/activity/sleep",
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual({
			records: [NAP, SCORED_NIGHT],
			next_token: SECOND_PAGE_TOKEN,
		});
	});

	it("carries the cycle each sleep belongs to, and names it in the page schema", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { declared, page } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				declared: (await client.listTools()).tools.find(
					(tool) => tool.name === "list_sleeps",
				),
				page: await client.callTool({ name: "list_sleeps", arguments: {} }),
			}),
		);

		expect(page.isError).not.toBe(true);
		// The join back to the cycle: without it, a model that found a sleep here
		// has to re-derive its cycle by date arithmetic.
		expect(
			(page.structuredContent as { records: Record<string, unknown>[] })
				.records,
		).toEqual([
			expect.objectContaining({ cycle_id: ONSET_CYCLE_ID }),
			expect.objectContaining({ cycle_id: ONSET_CYCLE_ID }),
		]);

		const record = declaredSleepRecord(declared?.outputSchema);
		expect(Object.keys(record.properties)).toContain("cycle_id");
		// Named, but never insisted on: one record WHOOP sends without it must not
		// take the whole page down.
		expect(record.required).not.toContain("cycle_id");
	});

	it("relays nextToken verbatim, and ends on an explicit next_token: null", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const lastPage = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "list_sleeps",
					arguments: { nextToken: SECOND_PAGE_TOKEN, limit: 5 },
				}),
		);

		expect(lastPage.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				path: "/developer/v2/activity/sleep",
				query: { nextToken: SECOND_PAGE_TOKEN, limit: "5" },
			}),
		);
		// The last page names its end the way the real WHOOP does: an explicit
		// `next_token: null`, not an absent field.
		expect(lastPage.structuredContent).toEqual({
			records: [OLDER_NIGHT],
			next_token: null,
		});
	});

	it("reads one sleep by id, mirroring WHOOP's record verbatim", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "get_sleep",
					arguments: { sleepId: SCORED_NIGHT.id },
				}),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: `/developer/v2/activity/sleep/${SCORED_NIGHT.id}`,
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual(SCORED_NIGHT);
	});

	it("reads the sleep that started a cycle, mirroring WHOOP's record verbatim", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "get_cycle_sleep",
					arguments: { cycleId: ONSET_CYCLE_ID },
				}),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: `/developer/v2/cycle/${ONSET_CYCLE_ID}/sleep`,
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual(SCORED_NIGHT);
	});

	it("says the sleep was not found when WHOOP answers 404, suggesting no retry", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);
		const missingId = "00000000-0000-4000-8000-000000000404";

		const outcome = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => callToolOutcome(client, "get_sleep", { sleepId: missingId }),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/not found/i);
		expect(outcome.text).toContain(missingId);
		expect(outcome.text).not.toMatch(/retry/i);
	});

	it("says the cycle has no sleep yet when the join answers 404", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);
		const sleeplessCycleId = 404_404;

		const outcome = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				callToolOutcome(client, "get_cycle_sleep", {
					cycleId: sleeplessCycleId,
				}),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain(`${sleeplessCycleId}`);
		expect(outcome.text).toMatch(/no sleep/i);
		expect(outcome.text).toMatch(/yet/i);
	});
});

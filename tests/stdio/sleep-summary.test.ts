import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	callToolOutcome,
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The offset every seeded record carries — WHOOP's own `±HH:MM` form. */
const TIMEZONE_OFFSET = "-05:00";

/** How long each seeded night was awake in bed, kept equal across nights. */
const AWAKE_MILLI = 1_800_000;

/** One night to seed, said in the terms the digest reports it back in. */
type NightSeed = {
	/** The local day it started on, at {@link TIMEZONE_OFFSET}. */
	day: string;
	performance: number;
	efficiency: number;
	inBedMilli: number;
};

/** The rate WHOOP reports for a night it measured breathing on. */
const RESPIRATORY_RATE = 16.113_281_25;

/**
 * What a night's score says about the respiratory rate. WHOOP requires only the
 * sleep-needed and stage-summary blocks of a scored sleep, so a scored night may
 * carry the measured rate, an explicit null, or no such key at all — all three
 * are records WHOOP is allowed to send.
 */
type RespiratoryRate = { respiratory_rate?: number | null };

/**
 * A scored night in WHOOP's own v2 shape, seeded onto one local day: it starts
 * at 22:00 that day at the offset the record carries, which is already the next
 * date in UTC — so a digest that labels a night by its own offset reports the
 * day named here, never the UTC one.
 */
function scoredNight(
	seed: NightSeed,
	respiratory: RespiratoryRate = { respiratory_rate: RESPIRATORY_RATE },
): Record<string, unknown> {
	const start = Date.parse(`${seed.day}T22:00:00.000${TIMEZONE_OFFSET}`);
	const asleepMilli = seed.inBedMilli - AWAKE_MILLI;

	return {
		id: `night-${seed.day}`,
		v1_id: null,
		user_id: 10_129,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(start + seed.inBedMilli).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(start + seed.inBedMilli).toISOString(),
		timezone_offset: TIMEZONE_OFFSET,
		nap: false,
		score_state: "SCORED",
		score: {
			stage_summary: {
				total_in_bed_time_milli: seed.inBedMilli,
				total_awake_time_milli: AWAKE_MILLI,
				total_no_data_time_milli: 0,
				total_light_sleep_time_milli: asleepMilli / 2,
				total_slow_wave_sleep_time_milli: asleepMilli / 4,
				total_rem_sleep_time_milli: asleepMilli / 4,
				sleep_cycle_count: 4,
				disturbance_count: 6,
			},
			sleep_needed: {
				baseline_milli: 27_395_716,
				need_from_sleep_debt_milli: 352_230,
				need_from_recent_strain_milli: 208_595,
				need_from_recent_nap_milli: -12_312,
			},
			...respiratory,
			sleep_performance_percentage: seed.performance,
			sleep_consistency_percentage: 90,
			sleep_efficiency_percentage: seed.efficiency,
		},
	};
}

/**
 * A week of nights, newest first the way WHOOP lists them. The numbers are
 * chosen so every mean lands exactly: performance means 80 over 62…98, time in
 * bed means 30_600_000 over 25_200_000…36_000_000, efficiency means 91 over
 * 88…94.
 */
const NIGHT_SEEDS: NightSeed[] = [
	{
		day: "2026-07-28",
		performance: 98,
		efficiency: 94,
		inBedMilli: 36_000_000,
	},
	{
		day: "2026-07-27",
		performance: 92,
		efficiency: 93,
		inBedMilli: 34_200_000,
	},
	{
		day: "2026-07-26",
		performance: 86,
		efficiency: 92,
		inBedMilli: 32_400_000,
	},
	{
		day: "2026-07-25",
		performance: 80,
		efficiency: 91,
		inBedMilli: 30_600_000,
	},
	{
		day: "2026-07-24",
		performance: 74,
		efficiency: 90,
		inBedMilli: 28_800_000,
	},
	{
		day: "2026-07-23",
		performance: 68,
		efficiency: 89,
		inBedMilli: 27_000_000,
	},
	{
		day: "2026-07-22",
		performance: 62,
		efficiency: 88,
		inBedMilli: 25_200_000,
	},
];

const NIGHTS = NIGHT_SEEDS.map((seed) => scoredNight(seed));

/**
 * The newest night as WHOOP sends it when it has no respiratory rate to report:
 * scored, with the key simply absent from the score object. Every other figure
 * is {@link NIGHTS}[0]'s own, so a week holding this night digests identically.
 */
const NIGHT_WITHOUT_RESPIRATORY_RATE = scoredNight(NIGHT_SEEDS[0], {});

/**
 * The same silence said the other way WHOOP says it, on the night behind it: an
 * explicit `respiratory_rate: null` rather than an absent key.
 */
const NIGHT_WITH_NULL_RESPIRATORY_RATE = scoredNight(NIGHT_SEEDS[1], {
	respiratory_rate: null,
});

/**
 * An afternoon nap on the second-newest night's day, scored — and scored
 * badly, with stage times unlike any night's, so a digest that let it into the
 * nightly statistics would say so loudly.
 */
const NAP = {
	...scoredNight({
		day: "2026-07-27",
		performance: 10,
		efficiency: 10,
		inBedMilli: 2_700_000,
	}),
	id: "nap-2026-07-27",
	nap: true,
	start: "2026-07-27T19:00:00.000Z",
	end: "2026-07-27T19:45:00.000Z",
};

/**
 * The oldest night, still waiting to be scored: `score_state` PENDING_SCORE
 * with an explicit `score: null` (observed 2026-08-02). Its figures were the
 * low of every metric in the week, so a digest that let an unscored night into
 * the statistics would move all three.
 */
const PENDING_NIGHT = {
	...NIGHTS[6],
	score_state: "PENDING_SCORE",
	score: null,
};

/** The rows a digest reports for {@link NIGHT_SEEDS}, newest night first. */
const PER_DAY = NIGHT_SEEDS.map((seed) => ({
	day: seed.day,
	score_state: "SCORED",
	sleep_performance_percentage: seed.performance,
	time_in_bed_milli: seed.inBedMilli,
	sleep_efficiency_percentage: seed.efficiency,
}));

/**
 * The digest a whole week of {@link NIGHTS} comes back as, the nap counted
 * apart from them — what every seven-night listing of that week reports,
 * whatever WHOOP did or did not say about breathing.
 */
const WEEK_DIGEST = {
	days_requested: 7,
	days_with_records: 7,
	days_scored: 7,
	nap_count: 1,
	sleep_performance_percentage: { mean: 80, min: 62, max: 98 },
	time_in_bed_milli: {
		mean: 30_600_000,
		min: 25_200_000,
		max: 36_000_000,
	},
	sleep_efficiency_percentage: { mean: 91, min: 88, max: 94 },
	stage_totals: {
		light_milli: 100_800_000,
		sws_milli: 50_400_000,
		rem_milli: 50_400_000,
		awake_milli: 12_600_000,
	},
	per_day: PER_DAY,
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

/** The token that reaches the page at the given index. */
function pageToken(index: number): string {
	return `page-${index}`;
}

/**
 * A stand-in WHOOP serving the v2 sleep collection as the given pages —
 * chained by next_token exactly as WHOOP chains its own, the last one ending on
 * an explicit `next_token: null` — and recording every request, query string
 * included, so a case can assert what was actually sent upstream.
 */
async function startFakeWhoop(
	pages: readonly (readonly unknown[])[],
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
			const known = url.pathname === "/developer/v2/activity/sleep";
			const asked = url.searchParams.get("nextToken");
			const index = pages.findIndex(
				(_page, at) => pageToken(at) === (asked ?? pageToken(0)),
			);
			const answer = known
				? {
						records: pages[index] ?? [],
						next_token: index + 1 < pages.length ? pageToken(index + 1) : null,
					}
				: undefined;

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

describe("the sleep summary over real stdio", () => {
	it("digests a week of nights, counting the nap apart from them", async () => {
		const whoop = await startFakeWhoop([
			[NIGHTS[0], NIGHTS[1], NAP, ...NIGHTS.slice(2)],
		]);
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_sleep_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(whoop.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/developer/v2/activity/sleep",
				authorization: "Bearer an-access-token",
			}),
		);
		expect(result.structuredContent).toEqual(WEEK_DIGEST);
	});

	it("digests a week whose newest scores say nothing about breathing", async () => {
		const whoop = await startFakeWhoop([
			[
				NIGHT_WITHOUT_RESPIRATORY_RATE,
				NIGHT_WITH_NULL_RESPIRATORY_RATE,
				NAP,
				...NIGHTS.slice(2),
			],
		]);
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_sleep_summary", arguments: {} }),
		);

		// WHOOP asks for neither an absent nor a null respiratory rate to mean
		// anything, so neither night is a record to refuse: the week reads exactly
		// as it does when every score carries the rate.
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(WEEK_DIGEST);
	});

	it("gives an unscored night its row and keeps it out of every statistic", async () => {
		const whoop = await startFakeWhoop([
			[NIGHTS[0], NIGHTS[1], NAP, ...NIGHTS.slice(2, 6), PENDING_NIGHT],
		]);
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_sleep_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			days_requested: 7,
			// The night is a night WHOOP holds, but not one it has scored.
			days_with_records: 7,
			days_scored: 6,
			nap_count: 1,
			sleep_performance_percentage: { mean: 83, min: 68, max: 98 },
			time_in_bed_milli: {
				mean: 31_500_000,
				min: 27_000_000,
				max: 36_000_000,
			},
			sleep_efficiency_percentage: { mean: 91.5, min: 89, max: 94 },
			stage_totals: {
				light_milli: 89_100_000,
				sws_milli: 44_550_000,
				rem_milli: 44_550_000,
				awake_milli: 10_800_000,
			},
			per_day: [
				...PER_DAY.slice(0, 6),
				{
					day: "2026-07-22",
					score_state: "PENDING_SCORE",
					sleep_performance_percentage: null,
					time_in_bed_milli: null,
					sleep_efficiency_percentage: null,
				},
			],
		});
	});

	it("follows WHOOP's pagination as far back as the asked-for days reach", async () => {
		const whoop = await startFakeWhoop([
			[NIGHTS[0], NIGHTS[1], NAP],
			NIGHTS.slice(2),
		]);
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({
					name: "get_sleep_summary",
					arguments: { days: 5 },
				}),
		);

		expect(result.isError).not.toBe(true);
		// The second page is reached the way WHOOP says to reach it: with the
		// next_token the first page named.
		expect(whoop.requests.map((request) => request.query.nextToken)).toEqual([
			undefined,
			pageToken(1),
		]);
		expect(result.structuredContent).toEqual({
			days_requested: 5,
			days_with_records: 5,
			days_scored: 5,
			nap_count: 1,
			sleep_performance_percentage: { mean: 86, min: 74, max: 98 },
			time_in_bed_milli: {
				mean: 32_400_000,
				min: 28_800_000,
				max: 36_000_000,
			},
			sleep_efficiency_percentage: { mean: 92, min: 90, max: 94 },
			stage_totals: {
				light_milli: 76_500_000,
				sws_milli: 38_250_000,
				rem_milli: 38_250_000,
				awake_milli: 9_000_000,
			},
			// Nights from both pages, the newest three from the first and the next
			// two from the second.
			per_day: PER_DAY.slice(0, 5),
		});
	});

	it("answers an empty listing with a zero-count digest rather than an error", async () => {
		const whoop = await startFakeWhoop([[]]);
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_sleep_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			days_requested: 7,
			days_with_records: 0,
			days_scored: 0,
			nap_count: 0,
			// Nothing to average is said as nothing, never as a zero that would
			// read like a terrible night.
			sleep_performance_percentage: { mean: null, min: null, max: null },
			time_in_bed_milli: { mean: null, min: null, max: null },
			sleep_efficiency_percentage: { mean: null, min: null, max: null },
			stage_totals: {
				light_milli: 0,
				sws_milli: 0,
				rem_milli: 0,
				awake_milli: 0,
			},
			per_day: [],
		});
	});

	it("refuses a days outside 1-30 without asking WHOOP anything", async () => {
		const whoop = await startFakeWhoop([[NIGHTS[0]]]);
		const store = await temporaryStore();
		await seedStore(store);

		const outcomes = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => [
				await callToolOutcome(client, "get_sleep_summary", { days: 0 }),
				await callToolOutcome(client, "get_sleep_summary", { days: 31 }),
			],
		);

		for (const outcome of outcomes) {
			expect(outcome.failed).toBe(true);
		}
		// The bounds are the schema's, so a call outside them never becomes a
		// request against someone's WHOOP account.
		expect(whoop.requests).toEqual([]);
	});
});

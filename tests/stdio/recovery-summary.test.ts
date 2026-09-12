import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/**
 * The offset every seeded record carries — WHOOP's own `±HH:MM` form, and a
 * positive one on purpose: a night ending at 06:00 there ended the day before
 * in UTC, so a digest that names a day at the record's own offset reports the
 * day seeded here and one reading UTC reports the day before.
 */
const TIMEZONE_OFFSET = "+09:00";

/** How long every seeded night lasts, onset to wake: eight hours in bed. */
const IN_BED_MILLI = 28_800_000;

/** One cycle-day to seed, said in the terms the digest reports it back in. */
type DaySeed = {
	/**
	 * The wake day that names it: the date the night that opened the
	 * cycle ended on, at {@link TIMEZONE_OFFSET}. The cycle itself began the
	 * evening before.
	 */
	day: string;
	/** The id WHOOP joins the day's recovery and its opening sleep to the cycle by. */
	cycleId: number;
	recoveryScore: number;
	hrvMilli: number;
	restingHeartRate: number;
};

/**
 * When a seeded day's user woke into it: 06:00 that morning, at
 * {@link TIMEZONE_OFFSET}, in epoch milliseconds.
 */
function wakeOf(seed: DaySeed): number {
	return Date.parse(`${seed.day}T06:00:00.000${TIMEZONE_OFFSET}`);
}

/**
 * When a seeded cycle starts: WHOOP bounds a cycle at sleep onset, so it opens
 * where the night carrying its id opens — 22:00 the evening before the morning
 * that names it.
 */
function startOf(seed: DaySeed): number {
	return wakeOf(seed) - IN_BED_MILLI;
}

/**
 * The instant a wall-clock time at {@link TIMEZONE_OFFSET} falls on — how a
 * seeded record says where it began and ended in the terms it was lived in.
 */
function localInstant(local: string): string {
	return new Date(`${local}${TIMEZONE_OFFSET}`).toISOString();
}

/**
 * A closed, scored cycle in WHOOP's own v2 shape: it runs from the onset of
 * the night that opens it to the onset of the next one, a day later.
 */
function scoredCycle(seed: DaySeed): Record<string, unknown> {
	const start = startOf(seed);

	return {
		id: seed.cycleId,
		user_id: 10_129,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(start + 3_600_000).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(start + 86_400_000).toISOString(),
		timezone_offset: TIMEZONE_OFFSET,
		score_state: "SCORED",
		score: {
			strain: 5.2951527,
			kilojoule: 8288.297,
			average_heart_rate: 68,
			max_heart_rate: 141,
		},
	};
}

/**
 * The recovery WHOOP scored for a seeded day's cycle, in its own v2 shape:
 * keyed by the cycle it scores and the sleep it was computed from, and carrying
 * no start or offset of its own — nothing on it says which day it belongs to.
 */
function scoredRecovery(seed: DaySeed): Record<string, unknown> {
	const scoredAt = wakeOf(seed);

	return {
		cycle_id: seed.cycleId,
		sleep_id: `sleep-${seed.day}`,
		user_id: 10_129,
		created_at: new Date(scoredAt).toISOString(),
		updated_at: new Date(scoredAt + 3_600_000).toISOString(),
		score_state: "SCORED",
		score: {
			user_calibrating: false,
			recovery_score: seed.recoveryScore,
			resting_heart_rate: seed.restingHeartRate,
			hrv_rmssd_milli: seed.hrvMilli,
			spo2_percentage: 95.6875,
			skin_temp_celsius: 33.7,
		},
	};
}

/**
 * What WHOOP scores a night by, in its own v2 shape. Nothing in the digest
 * reads it — a day is named by when the night ended, not by how it went — so
 * every seeded night shares one, rather than each carrying figures a case
 * would have to be read past.
 */
const SLEEP_SCORE = {
	stage_summary: {
		total_in_bed_time_milli: IN_BED_MILLI,
		total_awake_time_milli: 1_800_000,
		total_no_data_time_milli: 0,
		total_light_sleep_time_milli: 13_500_000,
		total_slow_wave_sleep_time_milli: 6_750_000,
		total_rem_sleep_time_milli: 6_750_000,
		sleep_cycle_count: 4,
		disturbance_count: 6,
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
	sleep_efficiency_percentage: 93.75,
};

/**
 * The night that opened a seeded day's cycle, in WHOOP's own v2 shape: it
 * carries that cycle's id back the way WHOOP's records do, begins where the
 * cycle begins, and ends at the wake that names the day.
 */
function onsetSleep(seed: DaySeed): Record<string, unknown> {
	const start = startOf(seed);
	const end = wakeOf(seed);

	return {
		id: `sleep-${seed.day}`,
		cycle_id: seed.cycleId,
		v1_id: null,
		user_id: 10_129,
		created_at: new Date(end).toISOString(),
		updated_at: new Date(end + 600_000).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
		timezone_offset: TIMEZONE_OFFSET,
		nap: false,
		score_state: "SCORED",
		score: SLEEP_SCORE,
	};
}

/**
 * A week of cycle-days, newest first the way WHOOP lists them. The numbers are
 * chosen so every mean lands exactly: recovery means 58 over 40…76, HRV means
 * 40.5 over 31.5…49.5, resting heart rate means 59 over 50…68.
 */
const DAY_SEEDS: DaySeed[] = [
	{
		day: "2026-07-28",
		cycleId: 93_845,
		recoveryScore: 76,
		hrvMilli: 49.5,
		restingHeartRate: 68,
	},
	{
		day: "2026-07-27",
		cycleId: 93_844,
		recoveryScore: 70,
		hrvMilli: 46.5,
		restingHeartRate: 65,
	},
	{
		day: "2026-07-26",
		cycleId: 93_843,
		recoveryScore: 64,
		hrvMilli: 43.5,
		restingHeartRate: 62,
	},
	{
		day: "2026-07-25",
		cycleId: 93_842,
		recoveryScore: 58,
		hrvMilli: 40.5,
		restingHeartRate: 59,
	},
	{
		day: "2026-07-24",
		cycleId: 93_841,
		recoveryScore: 52,
		hrvMilli: 37.5,
		restingHeartRate: 56,
	},
	{
		day: "2026-07-23",
		cycleId: 93_840,
		recoveryScore: 46,
		hrvMilli: 34.5,
		restingHeartRate: 53,
	},
	{
		day: "2026-07-22",
		cycleId: 93_839,
		recoveryScore: 40,
		hrvMilli: 31.5,
		restingHeartRate: 50,
	},
];

/**
 * The week's cycles, newest first — the newest one still open, the way the
 * real newest cycle always is, and scored while it runs.
 */
const CYCLES = DAY_SEEDS.map((seed, at) =>
	at === 0 ? { ...scoredCycle(seed), end: null } : scoredCycle(seed),
);

/** The week's recoveries, newest first. */
const RECOVERIES = DAY_SEEDS.map(scoredRecovery);

/** The nights that opened the week's cycles, newest first. */
const SLEEPS = DAY_SEEDS.map(onsetSleep);

/**
 * The oldest day's recovery, still waiting to be scored: `score_state`
 * PENDING_SCORE with an explicit `score: null`. Its
 * figures were the low of every metric in the week, so a digest that let an
 * unscored day into the statistics would move all three.
 */
const PENDING_RECOVERY = {
	...RECOVERIES[6],
	score_state: "PENDING_SCORE",
	score: null,
};

/** The rows a digest reports for {@link DAY_SEEDS}, newest day first. */
const PER_DAY = DAY_SEEDS.map((seed) => ({
	day: seed.day,
	score_state: "SCORED",
	recovery_score: seed.recoveryScore,
	hrv_rmssd_milli: seed.hrvMilli,
	resting_heart_rate: seed.restingHeartRate,
}));

/** One request the stand-in WHOOP was asked to serve. */
type WhoopRequest = {
	method: string;
	path: string;
	query: Record<string, string>;
	authorization: string | undefined;
};

/** The paginated collections a case seeds, each as the pages WHOOP serves. */
type Collections = {
	cycles: readonly (readonly unknown[])[];
	recoveries: readonly (readonly unknown[])[];
	sleeps: readonly (readonly unknown[])[];
};

/** Which collection each v2 path serves. */
const COLLECTION_PATHS: Record<string, keyof Collections | undefined> = {
	"/developer/v2/cycle": "cycles",
	"/developer/v2/recovery": "recoveries",
	"/developer/v2/activity/sleep": "sleeps",
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/** The token that reaches the given page of the given collection. */
function pageToken(collection: keyof Collections, index: number): string {
	return `${collection}-${index}`;
}

/**
 * How the stand-in WHOOP answers a collection request: the pages the case
 * seeded, chained by next_token exactly as WHOOP chains its own, the last one
 * ending on an explicit `next_token: null`.
 */
function answerFor(url: URL, collections: Collections): unknown {
	const collection = COLLECTION_PATHS[url.pathname];
	if (collection === undefined) {
		return undefined;
	}
	const pages = collections[collection];
	const asked = url.searchParams.get("nextToken") ?? pageToken(collection, 0);
	const index = pages.findIndex(
		(_page, at) => pageToken(collection, at) === asked,
	);

	return {
		records: pages[index] ?? [],
		next_token:
			index + 1 < pages.length ? pageToken(collection, index + 1) : null,
	};
}

/**
 * A stand-in WHOOP serving the v2 cycle and recovery collections from the
 * seeded pages, and recording every request, query string included, so a case
 * can assert what was actually sent upstream.
 */
async function startFakeWhoop(collections: Collections): Promise<FakeWhoop> {
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
			const answer = answerFor(url, collections);
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

describe("the recovery summary over real stdio", () => {
	it("names every cycle-day by the morning it was woken into, asking once for sleeps", async () => {
		const whoop = await startFakeWhoop({
			cycles: [CYCLES],
			recoveries: [RECOVERIES],
			sleeps: [SLEEPS],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_recovery_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		// Every seeded cycle opened the evening before the morning that names it:
		// the newest at 22:00 on the 27th, the oldest at 22:00 on the 21st.
		expect(CYCLES[0].start).toBe(localInstant("2026-07-27T22:00:00.000"));
		expect(CYCLES[6].start).toBe(localInstant("2026-07-21T22:00:00.000"));

		const days = (
			result.structuredContent as { per_day: { day: string }[] }
		).per_day.map((row) => row.day);

		// The seven mornings those cycles were woken into, newest first — the
		// cycle that began on the 27th is the row named the 28th.
		expect(days).toEqual(DAY_SEEDS.map((seed) => seed.day));
		// Not one row is an evening a cycle began: the oldest evening, the 21st,
		// names nothing at all.
		expect(days).not.toContain("2026-07-21");
		// And the join those labels are read from was asked for once: one sleeps
		// listing, bounded server-side, beside the cycles and the recoveries.
		expect(
			whoop.requests.filter(
				(request) => request.path === "/developer/v2/activity/sleep",
			),
		).toHaveLength(1);
	});

	it("digests a week of cycle-days, joining each recovery to its cycle", async () => {
		const whoop = await startFakeWhoop({
			cycles: [CYCLES],
			recoveries: [RECOVERIES],
			sleeps: [SLEEPS],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_recovery_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		// Both listings are walked server-side, under the stored login.
		for (const path of ["/developer/v2/cycle", "/developer/v2/recovery"]) {
			expect(whoop.requests).toContainEqual(
				expect.objectContaining({
					method: "GET",
					path,
					authorization: "Bearer an-access-token",
				}),
			);
		}
		expect(result.structuredContent).toEqual({
			days_requested: 7,
			days_with_records: 7,
			days_scored: 7,
			recovery_score: { mean: 58, min: 40, max: 76 },
			hrv_rmssd_milli: { mean: 40.5, min: 31.5, max: 49.5 },
			resting_heart_rate: { mean: 59, min: 50, max: 68 },
			per_day: PER_DAY,
		});
	});

	it("gives a pending and a missing recovery their rows, out of every statistic", async () => {
		const whoop = await startFakeWhoop({
			cycles: [CYCLES],
			// The second-oldest day's recovery is missing outright — WHOOP holds no
			// record for that cycle at all — and the oldest is not scored yet. Both
			// break the two listings out of step, so a digest that paired them
			// positionally instead of joining on the cycle id would misreport the
			// last three days.
			recoveries: [[...RECOVERIES.slice(0, 5), PENDING_RECOVERY]],
			sleeps: [SLEEPS],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_recovery_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			days_requested: 7,
			// Six days WHOOP holds a recovery for — the missing one is not among
			// them — and five it has scored.
			days_with_records: 6,
			days_scored: 5,
			recovery_score: { mean: 64, min: 52, max: 76 },
			hrv_rmssd_milli: { mean: 43.5, min: 37.5, max: 49.5 },
			resting_heart_rate: { mean: 62, min: 56, max: 68 },
			per_day: [
				...PER_DAY.slice(0, 5),
				{
					day: "2026-07-23",
					score_state: "ABSENT",
					recovery_score: null,
					hrv_rmssd_milli: null,
					resting_heart_rate: null,
				},
				{
					day: "2026-07-22",
					score_state: "PENDING_SCORE",
					recovery_score: null,
					hrv_rmssd_milli: null,
					resting_heart_rate: null,
				},
			],
		});
	});

	it("answers a window with no cycles with a zero-count digest rather than an error", async () => {
		const whoop = await startFakeWhoop({
			cycles: [[]],
			recoveries: [[]],
			sleeps: [[]],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_recovery_summary", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			days_requested: 7,
			days_with_records: 0,
			days_scored: 0,
			// Nothing to average is said as nothing, never as a zero that would
			// read like the worst recovery of a lifetime.
			recovery_score: { mean: null, min: null, max: null },
			hrv_rmssd_milli: { mean: null, min: null, max: null },
			resting_heart_rate: { mean: null, min: null, max: null },
			per_day: [],
		});
	});
});

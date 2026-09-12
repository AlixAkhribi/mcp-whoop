import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The family whose `{date}` these cases complete. */
const DAY_URI_TEMPLATE = "whoop://day/{date}";

/** The variable in it — the one thing a person fills in. */
const DATE_VARIABLE = "date";

/** A fixed resource a user picks whole: no variable, so nothing to complete. */
const TODAY_URI = "whoop://today";

/** A pattern this server advertises no family under — a client's guess. */
const UNKNOWN_URI_TEMPLATE = "whoop://week/{start}";

/**
 * Where a case's WHOOP would be, if a case needed one: nothing listens there.
 * What the server promises about itself is answered from the registrations
 * alone, so anything reaching for WHOOP to say it would fail loudly here.
 */
const NO_WHOOP_BASE_URL = "http://127.0.0.1:1";

/** The offset every seeded record carries — WHOOP's own `±HH:MM` form. */
const TIMEZONE_OFFSET = "-05:00";

/** How long every seeded night lasts, onset to wake: eight hours in bed. */
const IN_BED_MILLI = 28_800_000;

const DAY_MS = 86_400_000;

/** When a seeded day's user woke into it: 06:00 that morning, where they live. */
function wakeOf(day: string): number {
	return Date.parse(`${day}T06:00:00.000${TIMEZONE_OFFSET}`);
}

/**
 * When a seeded cycle starts: WHOOP bounds a cycle at sleep onset, so it opens
 * where the night carrying its id opens — 22:00 the evening before the morning
 * that names it.
 */
function startOf(day: string): number {
	return wakeOf(day) - IN_BED_MILLI;
}

/** The id WHOOP joins a seeded day's night back to its cycle by. */
function cycleIdOf(day: string): number {
	return 90_000 + Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

/** A closed, scored cycle in WHOOP's own v2 shape, named by `day`'s morning. */
function scoredCycle(day: string): Record<string, unknown> {
	const start = startOf(day);

	return {
		id: cycleIdOf(day),
		user_id: 10_129,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(start + 3_600_000).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(start + DAY_MS).toISOString(),
		timezone_offset: TIMEZONE_OFFSET,
		score_state: "SCORED",
		score: {
			strain: 5.295_152_7,
			kilojoule: 8288.297,
			average_heart_rate: 68,
			max_heart_rate: 141,
		},
	};
}

/**
 * The night that opened a seeded day's cycle, in WHOOP's own v2 shape: it
 * carries that cycle's id back, begins where the cycle begins, and ends at the
 * wake that names the day. Its own start falls on the evening before — the
 * label a completion must never offer.
 */
function onsetSleep(day: string): Record<string, unknown> {
	const start = startOf(day);
	const end = wakeOf(day);

	return {
		id: `sleep-${day}`,
		cycle_id: cycleIdOf(day),
		v1_id: null,
		user_id: 10_129,
		created_at: new Date(end).toISOString(),
		updated_at: new Date(end + 600_000).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
		timezone_offset: TIMEZONE_OFFSET,
		nap: false,
		score_state: "SCORED",
		score: {
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
		},
	};
}

/** The morning this WHOOP's newest cycle was woken into. */
const NEWEST_DAY = "2026-07-28";

/** A run of consecutive wake days ending at {@link NEWEST_DAY}, newest first. */
function daysBackFrom(count: number): string[] {
	const newest = Date.parse(`${NEWEST_DAY}T00:00:00.000Z`);

	return Array.from({ length: count }, (_, back) =>
		new Date(newest - back * DAY_MS).toISOString().slice(0, 10),
	);
}

/**
 * How many days a completion offers, said here as the client sees it: the
 * thirty most recent cycles WHOOP holds. Restated rather than imported, so a
 * change to the count has to be made twice — once in the server, once in what
 * a user is promised.
 */
const RECENT_DAY_COUNT = 30;

/** The ten wake days most of these cases run against, newest first. */
const TEN_DAYS = daysBackFrom(10);

/** A date half typed: the year, the month, and the first digit of the day. */
const PARTIAL_DATE = "2026-07-2";

/** The one of the ten that falls outside it — the day typing on cannot reach. */
const OLDEST_DAY_OUTSIDE_THE_PREFIX = "2026-07-19";

/** One page of a WHOOP collection, cut where the query asked it to be cut. */
function pageOf(
	records: readonly unknown[],
	query: URLSearchParams,
): { records: readonly unknown[]; next_token: string | null } {
	const from = Number(query.get("nextToken") ?? 0);
	const limit = Number(query.get("limit") ?? records.length);
	const to = from + limit;

	return {
		records: records.slice(from, to),
		// WHOOP ends a chain on an explicit null, never on an absent field.
		next_token: to < records.length ? String(to) : null,
	};
}

/** What a stand-in WHOOP holds: both of its collections, newest first. */
type WhoopHoldings = {
	cycles: readonly Record<string, unknown>[];
	sleeps: readonly Record<string, unknown>[];
};

/** A run of ordinary cycle-days: one cycle per day, and the night that opened it. */
function holdingsOf(days: readonly string[]): WhoopHoldings {
	return { cycles: days.map(scoredCycle), sleeps: days.map(onsetSleep) };
}

/**
 * The second cycle of a short day, and the short morning sleep that opened it:
 * the user woke at 06:00, went back to bed at 08:00 and woke again at 10:00,
 * so WHOOP bounded a second cycle at that second onset. Both of its bounds
 * fall on the very morning the day's first cycle is named by — one date,
 * two cycles.
 */
function shortMorningOf(day: string): {
	cycle: Record<string, unknown>;
	sleep: Record<string, unknown>;
} {
	const onset = wakeOf(day) + 7_200_000;
	const wake = onset + 7_200_000;
	// The next id WHOOP would mint: the newest morning's cycle plus one.
	const id = cycleIdOf(day) + 1;

	return {
		cycle: {
			...scoredCycle(day),
			id,
			start: new Date(onset).toISOString(),
			end: new Date(onset + DAY_MS).toISOString(),
		},
		sleep: {
			...onsetSleep(day),
			id: `sleep-${day}-morning`,
			cycle_id: id,
			start: new Date(onset).toISOString(),
			end: new Date(wake).toISOString(),
		},
	};
}

/**
 * A stand-in WHOOP holding a run of cycle-days and the nights that opened
 * them, newest first the way WHOOP lists, and paginating both collections the
 * way WHOOP does: `limit` records at a time, each page handing back the token
 * that reaches the next.
 */
async function startFakeWhoop({
	cycles,
	sleeps,
}: WhoopHoldings): Promise<string> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			const collection =
				url.pathname === "/developer/v2/cycle"
					? cycles
					: url.pathname === "/developer/v2/activity/sleep"
						? sleeps
						: undefined;
			response.writeHead(collection === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(
				JSON.stringify(
					collection === undefined ? {} : pageOf(collection, url.searchParams),
				),
			);
		});
	});

	return listenOnLoopback(server);
}

/** What a client is offered for `{date}` when it has typed `value` so far. */
async function completedDates(
	client: Client,
	value: string,
	uri: string = DAY_URI_TEMPLATE,
): Promise<{ values: string[]; total?: number; hasMore?: boolean }> {
	const result = await client.complete({
		ref: { type: "ref/resource", uri },
		argument: { name: DATE_VARIABLE, value },
	});

	return result.completion;
}

/** The JSON-RPC error a refused completion comes back as. */
type Refusal = { code: number; message: string };

/**
 * Completes against something meant to be refused, and reduces the rejection
 * to the JSON-RPC error the client was answered with. A completion that is
 * answered is itself the failure: the case asked to be refused.
 */
async function refusedCompletion(
	client: Client,
	uri: string,
): Promise<Refusal> {
	try {
		await completedDates(client, "", uri);
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(`completing ${uri} was answered rather than refused`);
}

describe("what the server promises about completion, over real stdio", () => {
	it("declares the completions capability beside resources", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const capabilities = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			async (client) => client.getServerCapabilities(),
		);

		// The promise a client checks before it ever sends `completion/complete`:
		// without it declared, the date in `whoop://day/{date}` is a value the
		// user has to know by heart.
		expect(capabilities?.completions).toBeDefined();
		// And the resource capability is untouched by it. This server still
		// pushes no listing updates and follows no resource: a completion tells
		// a client what a date could be, not that anything changed.
		expect(capabilities?.resources).toBeDefined();
		expect(capabilities?.resources?.listChanged).not.toBe(true);
		expect(capabilities?.resources).not.toHaveProperty("subscribe");
	});
});

describe("completing the date of a day, over real stdio", () => {
	it("offers the wake days of the cycles WHOOP holds, newest first", async () => {
		const whoopBaseUrl = await startFakeWhoop(holdingsOf(TEN_DAYS));
		const store = await temporaryStore();
		await seedStore(store);

		const completion = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => completedDates(client, ""),
		);

		// The Given, said plainly: every night ended the morning that names its
		// day, and began the evening before — the boundary a completion must not
		// offer, since no read would answer under it.
		expect(TEN_DAYS[0]).toBe(NEWEST_DAY);
		// Nothing typed yet, so nothing is narrowed away: the days this login has
		// lived, newest first, exactly as a read of one of them would label it.
		expect(completion.values).toEqual(TEN_DAYS);
		expect(completion.total).toBe(TEN_DAYS.length);
		expect(completion.hasMore).toBe(false);
	});

	it("narrows to the days the half-typed date is the start of", async () => {
		const whoopBaseUrl = await startFakeWhoop(holdingsOf(TEN_DAYS));
		const store = await temporaryStore();
		await seedStore(store);

		const completion = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => completedDates(client, PARTIAL_DATE),
		);

		// The Given: the run spans a boundary this prefix cuts at — nine of the
		// ten days fall in the twenties of July, and the tenth is the 19th.
		const inTheTwenties = TEN_DAYS.filter((day) =>
			day.startsWith(PARTIAL_DATE),
		);
		expect(inTheTwenties).toHaveLength(9);
		expect(TEN_DAYS).toContain(OLDEST_DAY_OUTSIDE_THE_PREFIX);
		// Only what is still reachable by typing on, in the order it was offered
		// in before a key was pressed: narrowing hides days, never reshuffles
		// them.
		expect(completion.values).toEqual(inTheTwenties);
		expect(completion.values).not.toContain(OLDEST_DAY_OUTSIDE_THE_PREFIX);
		expect(completion.total).toBe(inTheTwenties.length);
		expect(completion.hasMore).toBe(false);
	});

	it("offers a morning woken into twice once", async () => {
		// Thirty cycles, twenty-nine days: the newest morning is a short day —
		// the user woke, went back to bed, and WHOOP bounded a second cycle at
		// that second onset — so two of the thirty cycles are named by one date.
		const days = daysBackFrom(RECENT_DAY_COUNT - 1);
		const doubledMorning = shortMorningOf(NEWEST_DAY);
		const ordinary = holdingsOf(days);
		const whoopBaseUrl = await startFakeWhoop({
			cycles: [doubledMorning.cycle, ...ordinary.cycles],
			sleeps: [doubledMorning.sleep, ...ordinary.sleeps],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const completion = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => completedDates(client, ""),
		);

		// The completion suggests days, not cycles: a listing of the days this
		// login has lived that names a day twice is the lie. The doubled morning
		// surfaces once, at the top where its first cycle came, and the thirty
		// cycles in hand span twenty-nine days — the read does not reach for a
		// thirty-first cycle to make the count up to thirty.
		expect(completion.values).toEqual(days);
		expect(completion.values[0]).toBe(NEWEST_DAY);
		expect(completion.total).toBe(RECENT_DAY_COUNT - 1);
		expect(completion.hasMore).toBe(false);
	});

	it("offers the thirty most recent days and no more of a longer history", async () => {
		const whoopBaseUrl = await startFakeWhoop(
			holdingsOf(daysBackFrom(RECENT_DAY_COUNT + 1)),
		);
		const store = await temporaryStore();
		await seedStore(store);

		const completion = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => completedDates(client, ""),
		);

		// A count of cycles, never a span of the clock: WHOOP lists newest first,
		// so the walk stops after thirty days however far the history runs — and
		// stops there exactly, whatever WHOOP's page size hands back on the way.
		expect(completion.values).toEqual(daysBackFrom(RECENT_DAY_COUNT));
		expect(completion.total).toBe(RECENT_DAY_COUNT);
		expect(completion.hasMore).toBe(false);
	});
});

describe("completing something that is not a day, over real stdio", () => {
	it("offers nothing for a fixed resource, and refuses nothing", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const completion = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => completedDates(client, "", TODAY_URI),
		);

		// A URI a user picks whole has nothing to fill in, so there is nothing to
		// suggest and nothing wrong with asking: the protocol library answers an
		// empty completion itself. Pinned rather than rebuilt — the day family's
		// completer is registered beside a fixed set that must keep behaving
		// this way. And nothing went upstream to find that out: no WHOOP is
		// listening at all here.
		expect(completion.values).toEqual([]);
		expect(completion.hasMore).toBe(false);
	});

	it("refuses a template it does not serve as invalid params", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => refusedCompletion(client, UNKNOWN_URI_TEMPLATE),
		);

		// A pattern this server advertises nothing under names no family, so
		// there is no variable to complete and the ask itself is wrong: invalid
		// params, the same code a read of a URI outside the set is refused with.
		// The library's own answer, and one this server does not widen.
		expect(refusal.code).toBe(-32602);
	});
});

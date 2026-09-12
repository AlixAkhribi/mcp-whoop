import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** Where the recovery digest is addressed — the resource this suite is about. */
const RECOVERY_LAST_WEEK_URI = "whoop://recovery/last-week";

/** The head of the listing, ahead of everything. */
const _TODAY_URI = "whoop://today";

/** The resource that came before it, and that it is listed directly after. */
const BODY_MEASUREMENTS_URI = "whoop://body-measurements";

/** Listed second, straight after today's snapshot. */
const _PROFILE_URI = "whoop://profile";

/** The one listed after it, closing the canonical order. */
const _SLEEP_LAST_WEEK_URI = "whoop://sleep/last-week";

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
 * The week's cycles, newest first — the newest one still open, the way the real
 * newest cycle always is, and scored while it runs.
 */
const CYCLES = DAY_SEEDS.map((seed, at) =>
	at === 0 ? { ...scoredCycle(seed), end: null } : scoredCycle(seed),
);

/** The week's recoveries, newest first. */
const RECOVERIES = DAY_SEEDS.map(scoredRecovery);

/** The nights that opened the week's cycles, newest first. */
const SLEEPS = DAY_SEEDS.map(onsetSleep);

/** Which collection each v2 path serves, as one page ending the chain. */
const COLLECTIONS: Record<string, readonly unknown[] | undefined> = {
	"/developer/v2/cycle": CYCLES,
	"/developer/v2/recovery": RECOVERIES,
	"/developer/v2/activity/sleep": SLEEPS,
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every path this WHOOP was asked for, in order. */
	readonly requests: string[];
};

/**
 * A stand-in WHOOP serving a week of cycles, the nights that opened them and
 * the recoveries scored against them, each collection in one page that ends
 * the chain on an explicit `next_token: null` — and recording every path it
 * was asked for, so a case can assert what was, or was not, sent upstream.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? "/", "http://whoop.invalid");
		requests.push(pathname);
		request.resume();
		request.on("end", () => {
			const records = COLLECTIONS[pathname];
			response.writeHead(records === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(
				JSON.stringify(
					records === undefined ? {} : { records, next_token: null },
				),
			);
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/** The JSON-RPC error a refused read comes back as. */
type Refusal = { code: number; message: string };

/**
 * Reads a resource that is meant to fail, and reduces the rejection to the
 * JSON-RPC error the client was answered with. A read that succeeds is itself
 * the failure: the case asked for a grant this server may not act on to be
 * refused, not answered.
 */
async function refusedRead(client: Client, uri: string): Promise<Refusal> {
	try {
		await client.readResource({ uri });
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(`reading ${uri} was answered rather than refused`);
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

describe("the recovery digest as a resource, over real stdio", () => {
	it("refuses a read the login was granted no read:sleep for", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		// The cycles and the recoveries, but not the sleeps the days are named
		// by. A label may never vary with the grant, so the digest demands all
		// three scopes or answers nothing at all.
		await seedStore(store, ["read:cycles", "read:recovery"]);

		const { refusal, tools } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				refusal: await refusedRead(client, RECOVERY_LAST_WEEK_URI),
				tools: (await client.listTools()).tools.map((tool) => tool.name),
			}),
		);

		// This server's own refusal, not the protocol library's unknown-URI
		// answer: the resource exists and the request was well-formed — the
		// stored grant simply may not read it — so it comes back as the internal
		// error a failed read is, carrying the scope that is missing and the one
		// way to grant it.
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("read:sleep");
		expect(refusal.message).toContain("npx mcp-whoop login");
		// Decided from the store alone: not one request left for WHOOP, so no
		// half-fetched week was thrown away behind the refusal.
		expect(whoop.requests).toEqual([]);
		// And the tool this resource mirrors is not registered for such a login
		// at all — a model is never shown a summary the grant cannot answer.
		expect(tools).not.toContain("get_recovery_summary");
	});

	it("answers a read with the very text its tool answers with, unasked", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { called, read } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				// No arguments at all: the range the resource is fixed at is the range
				// this call falls back to, and the two have to be the same week.
				called: await client.callTool({
					name: "get_recovery_summary",
					arguments: {},
				}),
				read: await client.readResource({ uri: RECOVERY_LAST_WEEK_URI }),
			}),
		);

		// One item, not a bundle: the resource is one digest of one week.
		expect(read.contents).toHaveLength(1);
		expect(read.contents[0]).toMatchObject({
			uri: RECOVERY_LAST_WEEK_URI,
			mimeType: "application/json",
		});
		// A real week actually digested, so byte-identity below cannot be satisfied
		// by two surfaces agreeing on an empty answer.
		const digest = JSON.parse(textOf(read.contents[0])) as {
			per_day: { day: string }[];
		};
		expect(digest).toMatchObject({
			days_requested: 7,
			days_with_records: 7,
			days_scored: 7,
			recovery_score: { mean: 58, min: 40, max: 76 },
		});
		// And digested off the week WHOOP holds: every cycle opened the evening
		// before the morning that names it, and every row is that morning.
		expect(CYCLES[0].start).toBe(localInstant("2026-07-27T22:00:00.000"));
		expect(digest.per_day.map((row) => row.day)).toEqual(
			DAY_SEEDS.map((seed) => seed.day),
		);
		// Byte-identical, not merely equivalent: the two surfaces run one
		// fetch-and-digest path and render it once, so neither can drift from the
		// other — and the week is the shared path's own default, not a number the
		// resource happens to pass.
		expect(textOf(read.contents[0])).toBe(
			textOf((called.content as unknown[])[0]),
		);
	});

	it("lists whoop://recovery/last-week straight after whoop://body-measurements, self-described", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { resources } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.listResources(),
		);

		// The place this one holds in the order a user's picker shows them:
		// directly after the body that day was scored against, never ahead of it
		// and never with anything wedged between the two. What the whole curated
		// set is, entry for entry, is the last-listed resource's case to make.
		const uris = resources.map((resource) => resource.uri);
		expect(uris).toContain(BODY_MEASUREMENTS_URI);
		expect(uris.indexOf(RECOVERY_LAST_WEEK_URI)).toBe(
			uris.indexOf(BODY_MEASUREMENTS_URI) + 1,
		);

		const listed = resources.find(
			(resource) => resource.uri === RECOVERY_LAST_WEEK_URI,
		);
		expect(listed).toBeDefined();
		expect(listed).toMatchObject({
			uri: RECOVERY_LAST_WEEK_URI,
			name: "whoop_recovery_last_week",
			title: "WHOOP recovery, last week",
			mimeType: "application/json",
			// Both audiences and nothing else: a person picks the week out of a list,
			// and the model it is handed to has to know what span it is reading.
			annotations: { audience: ["user", "assistant"] },
		});
		// Exactly those two, in that order — `toMatchObject` would be satisfied by
		// a third audience nobody meant to address.
		expect(listed?.annotations?.audience).toEqual(["user", "assistant"]);
		// Self-describing: what is in the digest, in the words someone would use to
		// ask for it, rather than the endpoints it is read from.
		expect(listed?.description).toMatch(/seven days/i);
		expect(listed?.description).toMatch(/recovery score/i);
	});

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.readResource({ uri: RECOVERY_LAST_WEEK_URI }),
		);

		// Zero — immediately stale: the answer is bound to whoever the stored
		// login belongs to, a re-login can swap that account under an unchanged
		// URI, and this server has no way to call a cached copy back. Private:
		// it is one person's week.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	});
});

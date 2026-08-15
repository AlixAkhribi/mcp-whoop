import { createServer } from "node:http";

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
 * The offset every seeded cycle carries — WHOOP's own `±HH:MM` form, and a
 * positive one on purpose: a cycle starting at 06:00 there is still the day
 * before in UTC, so a digest that labels a day by the cycle's own offset
 * reports the day seeded here and one labeling by UTC reports the day before.
 */
const TIMEZONE_OFFSET = "+09:00";

/** One cycle-day to seed, said in the terms the digest reports it back in. */
type DaySeed = {
	/** The local day the cycle started on, at {@link TIMEZONE_OFFSET}. */
	day: string;
	/** The id WHOOP joins the day's recovery to the cycle by. */
	cycleId: number;
	recoveryScore: number;
	hrvMilli: number;
	restingHeartRate: number;
};

/** When a seeded cycle starts: 06:00 on its local day, in epoch milliseconds. */
function startOf(seed: DaySeed): number {
	return Date.parse(`${seed.day}T06:00:00.000${TIMEZONE_OFFSET}`);
}

/** A closed, scored cycle in WHOOP's own v2 shape, on one local day. */
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
 * no start or offset of its own — the day it belongs to lives on the cycle.
 */
function scoredRecovery(seed: DaySeed): Record<string, unknown> {
	const start = startOf(seed);

	return {
		cycle_id: seed.cycleId,
		sleep_id: `sleep-${seed.day}`,
		user_id: 10_129,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(start + 3_600_000).toISOString(),
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

/** Which collection each v2 path serves, as one page ending the chain. */
const COLLECTIONS: Record<string, readonly unknown[] | undefined> = {
	"/developer/v2/cycle": CYCLES,
	"/developer/v2/recovery": RECOVERIES,
};

/**
 * A stand-in WHOOP serving a week of cycles and the recoveries scored against
 * them, each collection in one page that ends the chain on an explicit
 * `next_token: null`.
 */
async function startFakeWhoop(): Promise<string> {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? "/", "http://whoop.invalid");
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

	return listenOnLoopback(server);
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

describe("the recovery digest as a resource, over real stdio", () => {
	it("answers a read with the very text its tool answers with, unasked", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { called, read } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
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
		expect(JSON.parse(textOf(read.contents[0]))).toMatchObject({
			days_requested: 7,
			days_with_records: 7,
			days_scored: 7,
			recovery_score: { mean: 58, min: 40, max: 76 },
		});
		// Byte-identical, not merely equivalent: the two surfaces run one
		// fetch-and-digest path and render it once, so neither can drift from the
		// other — and the week is the shared path's own default, not a number the
		// resource happens to pass.
		expect(textOf(read.contents[0])).toBe(
			textOf((called.content as unknown[])[0]),
		);
	});

	it("lists whoop://recovery/last-week straight after whoop://body-measurements, self-described", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { resources } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
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
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
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

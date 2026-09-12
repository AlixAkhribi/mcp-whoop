import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** Where the sleep digest is addressed — the resource this suite is about. */
const SLEEP_LAST_WEEK_URI = "whoop://sleep/last-week";

/**
 * The offset every seeded night carries — WHOOP's own `±HH:MM` form, and a
 * negative one on purpose: a night that ends at 06:00 there began the previous
 * evening, so a digest labeling a night by the evening it started reports the
 * day before the one seeded here.
 */
const TIMEZONE_OFFSET = "-05:00";

/** How long each seeded night was awake in bed, kept equal across nights. */
const AWAKE_MILLI = 1_800_000;

/** One night to seed, said in the terms the digest reports it back in. */
type NightSeed = {
	/**
	 * The wake day that names it: the date it ended on, read at
	 * {@link TIMEZONE_OFFSET}. The night itself began the evening before.
	 */
	day: string;
	performance: number;
	efficiency: number;
	inBedMilli: number;
};

/**
 * The instant a wall-clock time at {@link TIMEZONE_OFFSET} falls on — how a
 * seeded night says where it began and ended in the terms it was lived in.
 */
function localInstant(local: string): string {
	return new Date(`${local}${TIMEZONE_OFFSET}`).toISOString();
}

/**
 * A scored night in WHOOP's own v2 shape, seeded onto the wake day that names
 * it: it ends at 06:00 that morning at the offset the record carries, so it
 * began the evening before.
 */
function scoredNight(seed: NightSeed): Record<string, unknown> {
	const end = Date.parse(`${seed.day}T06:00:00.000${TIMEZONE_OFFSET}`);
	const start = end - seed.inBedMilli;
	const asleepMilli = seed.inBedMilli - AWAKE_MILLI;

	return {
		id: `night-${seed.day}`,
		v1_id: null,
		user_id: 10_129,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(end).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
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
			respiratory_rate: 16.113_281_25,
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

/** The week's nights, newest first. */
const NIGHTS = NIGHT_SEEDS.map(scoredNight);

/**
 * A stand-in WHOOP serving a week of sleeps in one page that ends the chain on
 * an explicit `next_token: null`.
 */
async function startFakeWhoop(): Promise<string> {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			const known = pathname === "/developer/v2/activity/sleep";
			response.writeHead(known ? 200 : 404, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(
				JSON.stringify(known ? { records: NIGHTS, next_token: null } : {}),
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

describe("the sleep digest as a resource, over real stdio", () => {
	it("carries the tool's own wake days, in the tool's own bytes", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { called, read } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			async (client) => ({
				called: await client.callTool({
					name: "get_sleep_summary",
					arguments: {},
				}),
				read: await client.readResource({ uri: SLEEP_LAST_WEEK_URI }),
			}),
		);

		const text = textOf(read.contents[0]);
		const digest = JSON.parse(text) as { per_day: { day: string }[] };

		// The newest night began at 20:00 on the 27th and is named the 28th, the
		// morning it ended on — the same wake days the tool prints.
		expect(NIGHTS[0].start).toBe(localInstant("2026-07-27T20:00:00.000"));
		expect(digest.per_day.map((row) => row.day)).toEqual(
			NIGHT_SEEDS.map((seed) => seed.day),
		);
		expect(digest.per_day.map((row) => row.day)).not.toContain("2026-07-21");
		// And byte-identical to the tool's answer: one digest, rendered once.
		expect(text).toBe(textOf((called.content as unknown[])[0]));
	});

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
					name: "get_sleep_summary",
					arguments: {},
				}),
				read: await client.readResource({ uri: SLEEP_LAST_WEEK_URI }),
			}),
		);

		// One item, not a bundle: the resource is one digest of one week.
		expect(read.contents).toHaveLength(1);
		expect(read.contents[0]).toMatchObject({
			uri: SLEEP_LAST_WEEK_URI,
			mimeType: "application/json",
		});
		// A real week actually digested, so byte-identity below cannot be satisfied
		// by two surfaces agreeing on an empty answer.
		expect(JSON.parse(textOf(read.contents[0]))).toMatchObject({
			days_requested: 7,
			days_with_records: 7,
			days_scored: 7,
			sleep_performance_percentage: { mean: 80, min: 62, max: 98 },
		});
		// Byte-identical, not merely equivalent: the two surfaces run one
		// fetch-and-digest path and render it once, so neither can drift from the
		// other — and the week is the shared path's own default, not a number the
		// resource happens to pass.
		expect(textOf(read.contents[0])).toBe(
			textOf((called.content as unknown[])[0]),
		);
	});

	it("lists whoop://sleep/last-week last of all, self-described", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { resources } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.listResources(),
		);

		// The place this one holds in the order a user's picker shows them: last,
		// the widest span at the end and nothing after it. What the whole curated
		// set is, entry for entry, is the case below.
		const uris = resources.map((resource) => resource.uri);
		expect(uris.at(-1)).toBe(SLEEP_LAST_WEEK_URI);

		const listed = resources.find(
			(resource) => resource.uri === SLEEP_LAST_WEEK_URI,
		);
		expect(listed).toBeDefined();
		expect(listed).toMatchObject({
			uri: SLEEP_LAST_WEEK_URI,
			name: "whoop_sleep_last_week",
			title: "WHOOP sleep, last week",
			mimeType: "application/json",
			// Both audiences and nothing else: a person picks the week out of a list,
			// and the model it is handed to has to know what span it is reading.
			annotations: { audience: ["user", "assistant"] },
		});
		// Exactly those two, in that order — `toMatchObject` would be satisfied by
		// a third audience nobody meant to address.
		expect(listed?.annotations?.audience).toEqual(["user", "assistant"]);
		// Self-describing: what is in the digest, in the words someone would use to
		// ask for it, rather than the endpoint it is read from.
		expect(listed?.description).toMatch(/seven nights/i);
		expect(listed?.description).toMatch(/sleep performance/i);
	});

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: SLEEP_LAST_WEEK_URI }),
		);

		// Zero — immediately stale: the answer is bound to whoever the stored
		// login belongs to, a re-login can swap that account under an unchanged
		// URI, and this server has no way to call a cached copy back. Private:
		// it is one person's week.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	});
});

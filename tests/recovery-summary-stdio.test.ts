import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** Starts a loopback server and reports the origin it ended up on. */
async function listenOnLoopback(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	opened.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	);

	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(
		join(tmpdir(), "mcp-whoop-recovery-summary-"),
	);
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

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
 * The week's cycles, newest first — the newest one still open, the way the
 * real newest cycle always is, and scored while it runs.
 */
const CYCLES = DAY_SEEDS.map((seed, at) =>
	at === 0 ? { ...scoredCycle(seed), end: null } : scoredCycle(seed),
);

/** The week's recoveries, newest first. */
const RECOVERIES = DAY_SEEDS.map(scoredRecovery);

/**
 * The oldest day's recovery, still waiting to be scored: `score_state`
 * PENDING_SCORE with an explicit `score: null` (observed 2026-08-02). Its
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
};

/** Which collection each v2 path serves. */
const COLLECTION_PATHS: Record<string, keyof Collections | undefined> = {
	"/developer/v2/cycle": "cycles",
	"/developer/v2/recovery": "recoveries",
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

/** Every read scope WHOOP defines — what a default login is granted. */
const ALL_READ_SCOPES = [
	"read:profile",
	"read:body_measurement",
	"read:cycles",
	"read:sleep",
	"read:recovery",
	"read:workout",
];

/** Seeds a store with a live login that was granted the given scopes. */
async function seedStore(store: string, scopes: string[]): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes,
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP.
 */
async function withClient<T>(
	env: { store: string; whoopBaseUrl: string },
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({
		name: "recovery-summary-stdio-test",
		version: "0.0.0",
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
		},
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

describe("the recovery summary over real stdio", () => {
	it("digests a week of cycle-days, joining each recovery to its cycle", async () => {
		const whoop = await startFakeWhoop({
			cycles: [CYCLES],
			recoveries: [RECOVERIES],
		});
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
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
	}, 30_000);

	it("gives a pending and a missing recovery their rows, out of every statistic", async () => {
		const whoop = await startFakeWhoop({
			cycles: [CYCLES],
			// The second-oldest day's recovery is missing outright — WHOOP holds no
			// record for that cycle at all — and the oldest is not scored yet. Both
			// break the two listings out of step, so a digest that paired them
			// positionally instead of joining on the cycle id would misreport the
			// last three days.
			recoveries: [[...RECOVERIES.slice(0, 5), PENDING_RECOVERY]],
		});
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
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
	}, 30_000);

	it("hides get_recovery_summary when read:cycles was not granted, keeping list_recoveries", async () => {
		const whoop = await startFakeWhoop({ cycles: [[]], recoveries: [[]] });
		const store = await temporaryStore();
		// A grant that reaches the recoveries but not the cycles they are days
		// of: the summary needs both listings, so every scope it reads has to
		// have been granted before it is served at all.
		await seedStore(store, ["read:recovery", "offline"]);

		const names = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => (await client.listTools()).tools.map((t) => t.name),
		);

		expect(names).not.toContain("get_recovery_summary");
		expect(names).toContain("list_recoveries");
	}, 30_000);

	it("answers a window with no cycles with a zero-count digest rather than an error", async () => {
		const whoop = await startFakeWhoop({ cycles: [[]], recoveries: [[]] });
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
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
	}, 30_000);
});

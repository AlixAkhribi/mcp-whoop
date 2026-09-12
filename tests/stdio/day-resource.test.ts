import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { daySnapshotSchema } from "@/whoop/reads/day-snapshot-model";
import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The family this suite is about: a day's snapshot, addressed by its date. */
const DAY_URI_TEMPLATE = "whoop://day/{date}";

/** The wake day these cases read: the morning of 2026-08-04. */
const DAY = "2026-08-04";

/** The one member of the family these cases ask for. */
const DAY_URI = `whoop://day/${DAY}`;

/**
 * A `{date}` that is no date at all: the 45th of the 13th month. Well-formed
 * to the eye and impossible on a calendar — the shape of value that has to be
 * refused before WHOOP is asked anything.
 */
const MALFORMED_DATE = "2026-13-45";

/** The member of the family that impossible date names. */
const MALFORMED_URI = `whoop://day/${MALFORMED_DATE}`;

/**
 * A real date this WHOOP holds no cycle for: years before the records the
 * stand-in was seeded with, so its window comes back holding no morning anyone
 * was woken into.
 */
const ABSENT_DAY = "2019-01-01";

/** The member of the family that absent day names. */
const ABSENT_DAY_URI = `whoop://day/${ABSENT_DAY}`;

/**
 * The label a cycle WHOOP filed no opening sleep for falls back to: the date
 * its own start falls on, read at the offset it carries — 22:00 on the 3rd,
 * the evening the cycle began.
 */
const FALLBACK_DAY = "2026-08-03";

/** The member of the family that fallback label names. */
const FALLBACK_DAY_URI = `whoop://day/${FALLBACK_DAY}`;

/** A `whoop://` URI this server serves nothing at — a client's typo or guess. */
const UNKNOWN_URI = "whoop://yesterday";

/** The offset every seeded record carries — WHOOP's own `±HH:MM` form. */
const TIMEZONE_OFFSET = "-05:00";

const DAY_MS = 86_400_000;

/**
 * The cycle the 4th names: closed, and bounded the way WHOOP bounds one — it
 * opens at sleep onset at 22:00 on the *3rd*, local, and runs to the next
 * onset. Its own start therefore falls on the 3rd; the morning it was woken
 * into is what names it.
 */
const CLOSED_CYCLE = {
	id: 93_844,
	user_id: 10_129,
	created_at: "2026-08-04T03:00:00.000Z",
	updated_at: "2026-08-05T03:00:00.000Z",
	start: "2026-08-04T03:00:00.000Z",
	end: "2026-08-05T03:00:00.000Z",
	timezone_offset: TIMEZONE_OFFSET,
	score_state: "SCORED",
	score: {
		strain: 11.174_622,
		kilojoule: 9288.297,
		average_heart_rate: 71,
		max_heart_rate: 158,
	},
};

/** The cycle still running when these records were taken — the day after. */
const OPEN_CYCLE = {
	...CLOSED_CYCLE,
	id: 93_845,
	created_at: "2026-08-05T03:00:00.000Z",
	updated_at: "2026-08-05T14:00:00.000Z",
	start: "2026-08-05T03:00:00.000Z",
	end: null,
};

/**
 * The night that opened the 4th's cycle: asleep at 22:00 on the 3rd, awake at
 * 06:00 on the 4th, both read at the offset it carries — the wake that names
 * the day.
 */
const ONSET_SLEEP = {
	id: "ecfc6a15-4661-442f-a9a4-f1621ee1a0f6",
	cycle_id: CLOSED_CYCLE.id,
	v1_id: null,
	user_id: 10_129,
	created_at: "2026-08-04T11:05:00.000Z",
	updated_at: "2026-08-04T11:10:00.000Z",
	start: "2026-08-04T03:00:00.000Z",
	end: "2026-08-04T11:00:00.000Z",
	timezone_offset: TIMEZONE_OFFSET,
	nap: false,
	score_state: "SCORED",
	score: {
		stage_summary: {
			total_in_bed_time_milli: 28_800_000,
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

/** The night that opened the next day's cycle — the neighbour not asked for. */
const NEXT_ONSET_SLEEP = {
	...ONSET_SLEEP,
	id: "9d0b1d02-6d1e-4f2a-9d0a-0f6f2a5a1c77",
	cycle_id: OPEN_CYCLE.id,
	created_at: "2026-08-05T11:05:00.000Z",
	updated_at: "2026-08-05T11:10:00.000Z",
	start: "2026-08-05T03:00:00.000Z",
	end: "2026-08-05T11:00:00.000Z",
};

/** The recovery WHOOP scored for the 4th's cycle, off that night. */
const SCORED_RECOVERY = {
	cycle_id: CLOSED_CYCLE.id,
	sleep_id: ONSET_SLEEP.id,
	user_id: 10_129,
	created_at: "2026-08-04T11:30:00.000Z",
	updated_at: "2026-08-04T11:35:00.000Z",
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
 * The first of two cycles woken into on the 4th: the ordinary night's cycle,
 * closed early because a second onset came that same morning. Opened by
 * ONSET_SLEEP, which ended at 06:00 local — so the 4th names it.
 */
const EARLIER_SHORT_CYCLE = {
	...CLOSED_CYCLE,
	end: "2026-08-04T13:00:00.000Z",
};

/**
 * The second cycle the same morning filed: the user went back to bed at 08:00
 * local on the 4th, and WHOOP bounded a new cycle at that onset. Its own start
 * falls on the 4th and the sleep opening it ended that morning too — so the 4th
 * names this one as well, and it is the later of the two.
 */
const LATER_SHORT_CYCLE = {
	...CLOSED_CYCLE,
	id: 93_846,
	created_at: "2026-08-04T13:00:00.000Z",
	updated_at: "2026-08-05T03:00:00.000Z",
	start: "2026-08-04T13:00:00.000Z",
	end: "2026-08-05T03:00:00.000Z",
};

/** The short morning sleep that opened it: 08:00 to 10:00 local on the 4th. */
const SHORT_MORNING_SLEEP = {
	...ONSET_SLEEP,
	id: "3f2b0f4a-8c21-4a77-b0d3-5a7c9e1f2b64",
	cycle_id: LATER_SHORT_CYCLE.id,
	created_at: "2026-08-04T15:05:00.000Z",
	updated_at: "2026-08-04T15:10:00.000Z",
	start: "2026-08-04T13:00:00.000Z",
	end: "2026-08-04T15:00:00.000Z",
	score: {
		...ONSET_SLEEP.score,
		stage_summary: {
			...ONSET_SLEEP.score.stage_summary,
			total_in_bed_time_milli: 7_200_000,
			total_awake_time_milli: 600_000,
			total_light_sleep_time_milli: 3_600_000,
			total_slow_wave_sleep_time_milli: 1_800_000,
			total_rem_sleep_time_milli: 1_200_000,
			sleep_cycle_count: 1,
			disturbance_count: 1,
		},
		sleep_performance_percentage: 24,
	},
};

/** The recovery WHOOP scored against that second cycle, off the short sleep. */
const SHORT_DAY_RECOVERY = {
	...SCORED_RECOVERY,
	cycle_id: LATER_SHORT_CYCLE.id,
	sleep_id: SHORT_MORNING_SLEEP.id,
	created_at: "2026-08-04T15:30:00.000Z",
	updated_at: "2026-08-04T15:35:00.000Z",
};

/**
 * The recovery WHOOP has taken the night in for but not finished scoring:
 * `score_state` PENDING_SCORE carrying an explicit `score: null` — a day
 * whose numbers are still coming, not a day that failed.
 */
const PENDING_RECOVERY = {
	cycle_id: CLOSED_CYCLE.id,
	sleep_id: ONSET_SLEEP.id,
	user_id: 10_129,
	created_at: "2026-08-04T11:30:00.000Z",
	updated_at: "2026-08-04T11:35:00.000Z",
	score_state: "PENDING_SCORE",
	score: null,
};

/** One request the server made upstream: what was asked for, and how narrowed. */
type UpstreamRequest = {
	readonly pathname: string;
	readonly query: URLSearchParams;
};

/**
 * What the stand-in WHOOP is holding, where a case needs it to hold something
 * other than a whole, scored day.
 */
type WhoopHoldings = {
	/**
	 * What the closed cycle's recovery join answers with. `null` is WHOOP holding
	 * no recovery for that cycle at all, which it says as a 404.
	 */
	readonly recovery?: unknown;
	/** What the sleep collection answers with, newest night first. */
	readonly sleepListing?: readonly unknown[];
	/** What the cycle collection answers with, in the order it lists them. */
	readonly cycleListing?: readonly unknown[];
	/** The one cycle whose recovery join answers; every other cycle's is a 404. */
	readonly recoveryCycleId?: number;
};

/**
 * A stand-in WHOOP holding two consecutive cycle-days, the nights that opened
 * them and the 4th's recovery — and recording every request it was asked, so a
 * case can say what the server went looking for. The collections answer whole:
 * WHOOP filters by a window of instants, and picking the day out of what comes
 * back is this server's own job.
 */
async function startFakeWhoop(holdings: WhoopHoldings = {}): Promise<{
	baseUrl: string;
	requests: UpstreamRequest[];
}> {
	const requests: UpstreamRequest[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		requests.push({ pathname: url.pathname, query: url.searchParams });
		request.resume();
		request.on("end", () => {
			const answer = answerFor(url, holdings);
			response.writeHead(answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/** How the stand-in WHOOP answers, newest record first the way WHOOP lists. */
function answerFor(
	url: URL,
	{
		recovery = SCORED_RECOVERY,
		sleepListing = [NEXT_ONSET_SLEEP, ONSET_SLEEP],
		cycleListing = [OPEN_CYCLE, CLOSED_CYCLE],
		recoveryCycleId = CLOSED_CYCLE.id,
	}: WhoopHoldings = {},
): unknown {
	if (url.pathname === "/developer/v2/cycle") {
		return { records: cycleListing, next_token: null };
	}
	if (url.pathname === "/developer/v2/activity/sleep") {
		return { records: sleepListing, next_token: null };
	}
	if (url.pathname === `/developer/v2/cycle/${recoveryCycleId}/recovery`) {
		// A recovery WHOOP holds none of is nothing to answer with: it falls
		// through to the 404 every unheld record here comes back as.
		return recovery ?? undefined;
	}

	return undefined;
}

/** The access token a seeded store holds — the material no refusal may carry. */
const SEEDED_ACCESS_TOKEN = "an-access-token";

/**
 * A stand-in WHOOP that refuses the cycles read with WHOOP's own 403, quoting
 * back the very bearer token the request was signed with — the shape of body
 * that turns a relayed message into a credential leak — and answers everything
 * else the way the healthy one does, so the failure a case sees is the one it
 * scripted rather than whichever of two collections lost a race.
 */
async function startWhoopRefusingCycles(): Promise<string> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			const refused = url.pathname === "/developer/v2/cycle";
			const answer = refused
				? {
						message: `The bearer token ${SEEDED_ACCESS_TOKEN} may not read cycles`,
					}
				: answerFor(url);
			response.writeHead(refused ? 403 : answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return listenOnLoopback(server);
}

/** The query one upstream collection was narrowed by, insisted on rather than assumed. */
function queryFor(
	requests: readonly UpstreamRequest[],
	pathname: string,
): URLSearchParams {
	const asked = requests.filter((request) => request.pathname === pathname);
	expect(asked, `WHOOP was never asked for ${pathname}`).toHaveLength(1);

	return asked[0].query;
}

/**
 * Holds a collection's query to a window of instants wide enough to hold any
 * cycle woken into on `date` at any offset a WHOOP record can carry — midnight
 * at +14:00 through the end of the day at -12:00, and the night that ended in
 * that wake — and narrow enough to still be a window: bounded at both ends, and
 * a handful of days rather than a whole history.
 */
function expectBoundedWindowAround(query: URLSearchParams, date: string): void {
	const start = Date.parse(query.get("start") ?? "");
	const end = Date.parse(query.get("end") ?? "");

	expect(Number.isNaN(start), `no start in ${query}`).toBe(false);
	expect(Number.isNaN(end), `no end in ${query}`).toBe(false);
	expect(start).toBeLessThanOrEqual(
		Date.parse(`${date}T00:00:00.000+14:00`) - DAY_MS,
	);
	expect(end).toBeGreaterThanOrEqual(
		Date.parse(`${date}T00:00:00.000-12:00`) + DAY_MS,
	);
	expect(end - start).toBeLessThanOrEqual(7 * DAY_MS);
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

/**
 * Where a case's WHOOP would be, if a case needed one: nothing listens there.
 * A listing is answered from the registrations alone, so anything reaching for
 * WHOOP to advertise the family would fail loudly here.
 */
const NO_WHOOP_BASE_URL = "http://127.0.0.1:1";

/**
 * The fixed set `resources/list` advertises, in its canonical order — the five
 * URIs a user picks whole. The day family is not among them and never will be:
 * a template is advertised as a pattern, never enumerated.
 */
const ALL_RESOURCE_URIS = [
	"whoop://today",
	"whoop://profile",
	"whoop://body-measurements",
	"whoop://recovery/last-week",
	"whoop://sleep/last-week",
];

describe("the day resource template, over real stdio", () => {
	it("lists whoop://day/{date} among the resource templates, self-described", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const listing = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => client.listResourceTemplates(),
		);

		// One family, not a catalogue: a template is a variable a person fills in,
		// and this server has exactly one thing a date names.
		expect(listing.resourceTemplates).toHaveLength(1);
		const listed = listing.resourceTemplates[0];
		expect(listed).toMatchObject({
			uriTemplate: DAY_URI_TEMPLATE,
			name: "whoop_day",
			title: "WHOOP day",
			mimeType: "application/json",
			// Both audiences, exactly as every plain resource here declares: a
			// person completes the date, and the model is handed what comes back.
			annotations: { audience: ["user", "assistant"] },
		});
		// The one thing a user has to know before typing a date: which date it is.
		// A day is named by the morning they woke — the date their WHOOP app shows
		// — never by the evening the cycle began.
		expect(listed?.description).toMatch(/woke|wake/i);
		// Nothing invented: a family has no modification time, and no member's is
		// known before it is read.
		expect(listed?.annotations).not.toHaveProperty("lastModified");
		expect(listed).not.toHaveProperty("lastModified");
		// The same hour the resource listing is cacheable for: what this server
		// advertises is the same for every login, so the two listings sit on one
		// policy — and private, since neither is anyone else's to reuse.
		expect(listing.ttlMs).toBe(3_600_000);
		expect(listing.cacheScope).toBe("private");
	});

	it("leaves resources/list the same five fixed URIs, with no day in it", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const listed = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			async (client) =>
				(await client.listResources()).resources.map(
					(resource) => resource.uri,
				),
		);

		// The set a user scans in their picker, unchanged: the family is a pattern
		// they complete, not a run of days folded into the curated list.
		expect(listed).toEqual(ALL_RESOURCE_URIS);
		expect(listed.some((uri) => uri.startsWith("whoop://day"))).toBe(false);
	});
});

describe("a read of one past day, over real stdio", () => {
	it("asks WHOOP for a window and answers the day woken into that morning", async () => {
		const { baseUrl: whoopBaseUrl, requests } = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: DAY_URI }),
		);

		// WHOOP has no read by date: both collections are asked for one bounded
		// window of instants, and the day is picked out of what comes back.
		expectBoundedWindowAround(queryFor(requests, "/developer/v2/cycle"), DAY);
		expectBoundedWindowAround(
			queryFor(requests, "/developer/v2/activity/sleep"),
			DAY,
		);
		// One item, not a bundle: the resource is one day's snapshot.
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0]).toMatchObject({
			uri: DAY_URI,
			mimeType: "application/json",
		});
		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			// The cycle whose opening sleep ended on the 4th — not the one still
			// running, and not the one whose own start falls on the 4th.
			cycle: CLOSED_CYCLE,
			recovery_state: "SCORED",
			recovery: SCORED_RECOVERY,
			sleep: ONSET_SLEEP,
		});
	});

	it("answers the later of two cycles woken into on the same morning", async () => {
		// The stand-in lists the earlier of the two first — not the newest-first
		// order WHOOP lists cycles in — so a rule that took whichever came first
		// out of the collection would answer with the wrong one.
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop({
			cycleListing: [EARLIER_SHORT_CYCLE, LATER_SHORT_CYCLE],
			sleepListing: [SHORT_MORNING_SLEEP, ONSET_SLEEP],
			recovery: SHORT_DAY_RECOVERY,
			recoveryCycleId: LATER_SHORT_CYCLE.id,
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: DAY_URI }),
		);

		// The Given: both nights ended on the morning of the 4th, at the offset
		// they carry — 06:00 and 10:00 local — so the date names both cycles.
		for (const sleep of [ONSET_SLEEP, SHORT_MORNING_SLEEP]) {
			expect(sleep.end.startsWith(DAY)).toBe(true);
		}
		// The day as WHOOP last filed it: the cycle that started later, with the
		// sleep that opened it and the recovery scored against it.
		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			cycle: LATER_SHORT_CYCLE,
			recovery_state: "SCORED",
			recovery: SHORT_DAY_RECOVERY,
			sleep: SHORT_MORNING_SLEEP,
		});
	});

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: DAY_URI }),
		);

		// The same promise every read here is served under: zero — immediately
		// stale, since `npx mcp-whoop login` can hand the store to a different
		// WHOOP account while the URI looks unchanged — and private, because a
		// day is one person's.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	});

	it("answers under the very schema the today tool registers its output as", async () => {
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: DAY_URI }),
		);

		// One shape for every day, today's included: a client that learned the
		// snapshot from `get_today_snapshot` reads any date without learning
		// anything new. Compared against what went in, so a field the schema
		// silently drops is a failure rather than a pass.
		const answered = JSON.parse(textOf(result.contents[0]));
		expect(daySnapshotSchema.parse(answered)).toEqual(answered);
	});
});

describe("a day WHOOP holds no score or no night for, over real stdio", () => {
	it("answers a day whose recovery is still pending with its state, not an error", async () => {
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop({
			recovery: PENDING_RECOVERY,
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: DAY_URI }),
		);

		// A score still being computed is a state of the day, reported the way
		// `whoop://today` already reports an unscored morning — the day exists
		// even when its score does not, so the read succeeds and says so.
		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			cycle: CLOSED_CYCLE,
			recovery_state: "PENDING_SCORE",
			recovery: PENDING_RECOVERY,
			sleep: ONSET_SLEEP,
		});
	});

	it("answers a day WHOOP holds no recovery for with an absent state, not an error", async () => {
		// WHOOP's answer for a cycle it has scored no recovery for at all: a 404
		// on the join, which is a fact about the day rather than a failed read.
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop({ recovery: null });
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: DAY_URI }),
		);

		// The day still happened — the cycle and the night that opened it are
		// right there — so it is answered with the recovery reported absent, not
		// refused as a day this server cannot speak for.
		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			cycle: CLOSED_CYCLE,
			recovery_state: "ABSENT",
			recovery: null,
			sleep: ONSET_SLEEP,
		});
	});

	it("answers a closed cycle WHOOP filed no opening sleep for by its start date", async () => {
		// The night that opened the 4th's cycle never filed: the window still
		// holds a sleep, but none carrying that cycle's id.
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop({
			sleepListing: [NEXT_ONSET_SLEEP],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: FALLBACK_DAY_URI }),
		);

		// With no wake to be named by, a closed cycle falls back to the date its
		// own start falls on and is still a day this server speaks for:
		// the cycle and its recovery are answered, and the night WHOOP has no
		// record of is reported as null rather than as an error. The neighbour's
		// night is in the window and is not borrowed — a sleep opens the cycle
		// whose id it carries, or no cycle at all.
		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			cycle: CLOSED_CYCLE,
			recovery_state: "SCORED",
			recovery: SCORED_RECOVERY,
			sleep: null,
		});
	});
});

/** The JSON-RPC error a refused read comes back as. */
type Refusal = { code: number; message: string; data?: unknown };

/**
 * Reads a resource that is meant to fail, and reduces the rejection to the
 * JSON-RPC error the client was answered with — code, message and data, the
 * three things a refusal is judged on. A read that succeeds is itself the
 * failure: the case asked to be refused, not answered.
 */
async function refusedRead(client: Client, uri: string): Promise<Refusal> {
	try {
		await client.readResource({ uri });
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");
		expect(typeof refusal.message).toBe("string");

		return refusal;
	}

	throw new Error(`reading ${uri} was answered rather than refused`);
}

describe("a read of a day this server cannot speak for, over real stdio", () => {
	it("refuses a malformed date as invalid params, echoing the URI, without asking WHOOP", async () => {
		const { baseUrl: whoopBaseUrl, requests } = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, MALFORMED_URI),
		);

		// The refusal the 2026-07-28 revision requires for a resource that does
		// not exist: invalid params, with the URI echoed in the error data, which
		// is how a client tells a miss from any other invalid-params refusal.
		expect(refusal.code).toBe(-32602);
		expect(refusal.data).toEqual({ uri: MALFORMED_URI });
		// And nothing went upstream: a date that is not a date is judged by this
		// server's own reading of it, before a request is ever signed.
		expect(requests).toEqual([]);
	});

	it("refuses a date WHOOP holds no cycle for as invalid params, saying so", async () => {
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, ABSENT_DAY_URI),
		);

		// A member of the family exists only when WHOOP holds the cycle its date
		// names, so a date it holds none for is a miss like any other: invalid
		// params, the URI echoed back — not this server failing to answer.
		expect(refusal.code).toBe(-32602);
		expect(refusal.data).toEqual({ uri: ABSENT_DAY_URI });
		// And said in a way a person can act on: which date has no day, rather
		// than a bare code.
		expect(refusal.message).toMatch(/no day/i);
		expect(refusal.message).toContain(ABSENT_DAY);
	});

	it("refuses the morning a sleepless cycle would have been woken into", async () => {
		// The same cycle the fallback label answers: its opening sleep never
		// filed, so the 4th is the morning it *would* have been woken into.
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop({
			sleepListing: [NEXT_ONSET_SLEEP],
		});
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, DAY_URI),
		);

		// A cycle with no wake is named by the one fact WHOOP holds about it —
		// where its start falls — and by nothing else. The morning it might have
		// opened is a guess this server does not make, so that date names no day
		// and is a miss like any other: invalid params, the URI echoed back.
		expect(refusal.code).toBe(-32602);
		expect(refusal.data).toEqual({ uri: DAY_URI });
	});

	it("leaves an upstream refusal an internal error, with the token scrubbed", async () => {
		const whoopBaseUrl = await startWhoopRefusingCycles();
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, DAY_URI),
		);

		// The day exists; this server could not fetch it. That is an internal
		// error and stays one — only a miss carries a code out of the seam, so
		// nothing WHOOP, a login or the transport does can dress a failure up as
		// a resource that does not exist.
		expect(refusal.code).toBe(-32603);
		// Still a description someone can act on: which read failed.
		expect(refusal.message).toMatch(/cycles read/i);
		// And nothing of the credential survives into it.
		expect(refusal.message).not.toContain(SEEDED_ACCESS_TOKEN);
		expect(refusal.message).toContain("[redacted]");
	});

	it("narrates the day and the refusal on the server's stderr", async () => {
		const { baseUrl: whoopBaseUrl } = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { refusal, stderr } = await withBuiltStdioClient(
			{ store, whoopBaseUrl, stderr: "pipe" },
			async (client, _transport, stderr) => ({
				refusal: await refusedRead(client, ABSENT_DAY_URI),
				stderr,
			}),
		);

		// A day read is narrated like every other read: named on stderr by the
		// member URI the client asked for — not by the pattern it matched, which
		// would name every day alike — and failed with the very words the client
		// was refused with, at a level the default threshold shows.
		await vi.waitFor(() => {
			expect(stderr()).toContain(ABSENT_DAY_URI);
		});
		expect(stderr()).toContain(`[error] ${ABSENT_DAY_URI}`);
		expect(stderr()).toContain(refusal.message);
	});

	it("still refuses an unknown fixed URI as invalid params, echoing it back", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => refusedRead(client, UNKNOWN_URI),
		);

		// Not this server's refusal to write: the protocol library answers a miss
		// itself, and a family registered beside the fixed set neither widens what
		// this server serves nor swallows a URI outside it. Pinned rather than
		// rebuilt — the day family's own refusals are shaped to match this one.
		expect(refusal.code).toBe(-32602);
		expect(refusal.data).toEqual({ uri: UNKNOWN_URI });
	});
});

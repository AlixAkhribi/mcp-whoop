import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The resource this suite is about: the snapshot heading the curated set. */
const TODAY_URI = "whoop://today";

/**
 * The date today's cycle is being lived under: the night carrying its id ends
 * at 05:25 on the 4th where it was lived, so the morning the user woke into
 * the open cycle is the 4th — the date their WHOOP app shows.
 */
const TODAY_DATE = "2026-08-04";

/** Today addressed the way any other day is: by the morning it was woken into. */
const TODAY_DAY_URI = `whoop://day/${TODAY_DATE}`;

/**
 * The label the open cycle falls back to while WHOOP has filed no opening
 * sleep for it: the date its own start falls on, read at the offset it carries
 * — 21:25 on the 3rd, the evening it began.
 */
const FALLBACK_DAY_URI = "whoop://day/2026-08-03";

/** A `whoop://` URI this server serves nothing at — a client's typo or guess. */
const UNKNOWN_URI = "whoop://yesterday";

/** The offset every seeded record carries — WHOOP's own `±HH:MM` form. */
const TIMEZONE_OFFSET = "-05:00";

/**
 * Today's cycle in WHOOP's own v2 shape: the newest one, still running —
 * `end: null`, an explicit null rather than an absent field — and scored
 * while it runs, so its strain is the strain so far.
 * It opens where the night carrying its id opens, since WHOOP bounds a cycle
 * at sleep onset: the evening before the morning that names the day.
 */
const OPEN_CYCLE = {
	id: 93_845,
	user_id: 10_129,
	created_at: "2026-08-04T03:25:44.774Z",
	updated_at: "2026-08-04T14:25:44.774Z",
	start: "2026-08-04T02:25:44.774Z",
	end: null,
	timezone_offset: TIMEZONE_OFFSET,
	score_state: "SCORED",
	score: {
		strain: 5.2951527,
		kilojoule: 8288.297,
		average_heart_rate: 68,
		max_heart_rate: 141,
	},
};

/** Yesterday's cycle, closed — the second record of the listing. */
const CLOSED_CYCLE = {
	...OPEN_CYCLE,
	id: 93_844,
	created_at: "2026-08-03T03:25:44.774Z",
	updated_at: "2026-08-04T02:25:44.774Z",
	start: "2026-08-03T02:25:44.774Z",
	end: "2026-08-04T02:25:44.774Z",
};

/**
 * The night that started today's cycle, in WHOOP's own v2 shape — naming that
 * cycle back as its `cycle_id`, the way WHOOP's records do.
 */
const ONSET_SLEEP = {
	id: "ecfc6a15-4661-442f-a9a4-f1621ee1a0f6",
	cycle_id: OPEN_CYCLE.id,
	v1_id: null,
	user_id: 10_129,
	created_at: "2026-08-04T10:26:44.774Z",
	updated_at: "2026-08-04T10:30:44.774Z",
	start: "2026-08-04T02:25:44.774Z",
	end: "2026-08-04T10:25:44.774Z",
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

/** The recovery WHOOP scored for today's cycle, off that night. */
const SCORED_RECOVERY = {
	cycle_id: OPEN_CYCLE.id,
	sleep_id: ONSET_SLEEP.id,
	user_id: 10_129,
	created_at: "2026-08-04T10:30:44.774Z",
	updated_at: "2026-08-04T10:35:44.774Z",
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
 * How the stand-in WHOOP answers: the cycle listing newest first — today's
 * open cycle at its head — and each join hanging off that cycle.
 */
function answerFor(
	url: URL,
	sleepListing: readonly unknown[] = [ONSET_SLEEP],
): unknown {
	if (url.pathname === "/developer/v2/cycle") {
		return { records: [OPEN_CYCLE, CLOSED_CYCLE], next_token: null };
	}
	if (url.pathname === "/developer/v2/activity/sleep") {
		return { records: sleepListing, next_token: null };
	}
	if (url.pathname === `/developer/v2/cycle/${OPEN_CYCLE.id}/recovery`) {
		return SCORED_RECOVERY;
	}
	if (url.pathname === `/developer/v2/cycle/${OPEN_CYCLE.id}/sleep`) {
		return ONSET_SLEEP;
	}

	return undefined;
}

/**
 * A stand-in WHOOP holding today's open cycle, its recovery and its onset
 * sleep — the whole day a snapshot speaks for. The nights are served as a
 * collection too, since that is the only way anything addressing a day by its
 * date can learn which morning a cycle was woken into; `sleepListing` is what
 * that collection answers, so a case can take the night away without taking
 * the day with it.
 */
async function startFakeWhoop({
	sleepListing,
}: {
	sleepListing?: readonly unknown[];
} = {}): Promise<string> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			const answer = answerFor(url, sleepListing);
			response.writeHead(answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return listenOnLoopback(server);
}

/**
 * A stand-in WHOOP that fails every request the same way — WHOOP's own status
 * and body, whatever a case needs to see relayed.
 */
async function startFailingWhoop(answer: {
	status: number;
	body: unknown;
}): Promise<string> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(answer.status, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer.body));
		});
	});

	return listenOnLoopback(server);
}

/** The access token a seeded store holds — the material no refusal may carry. */
const SEEDED_ACCESS_TOKEN = "an-access-token";

/**
 * A store whose file exists but is not a login at all — the half-written,
 * truncated or hand-edited state a login has to be redone from.
 */
async function corruptStore(store: string): Promise<void> {
	await writeFile(
		join(store, "tokens.json"),
		'{"accessToken": "an-acc',
		"utf8",
	);
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

/** The JSON-RPC error a refused read comes back as. */
type Refusal = { code: number; message: string; data?: unknown };

/**
 * Reads a resource that is meant to fail, and reduces the rejection to the
 * JSON-RPC error the client was answered with — code, message and data, the
 * three things a refusal is judged on. A read that succeeds is itself the
 * failure: the case asked for the way out to be named, not for an answer.
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

describe("the today snapshot as a resource, over real stdio", () => {
	it("lists whoop://today self-described, for the user and the assistant both", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const listed = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			async (client) =>
				(await client.listResources()).resources.find(
					(resource) => resource.uri === TODAY_URI,
				),
		);

		expect(listed).toBeDefined();
		expect(listed).toMatchObject({
			uri: TODAY_URI,
			name: "whoop_today",
			title: "WHOOP today",
			mimeType: "application/json",
			// Both audiences: a person picks it out of a list, and the model it is
			// handed to has to know what it is holding.
			annotations: { audience: ["user", "assistant"] },
		});
		// Question-shaped rather than endpoint-shaped: the description says what
		// the day it answers for is made of.
		expect(listed?.description).toMatch(/recovery/i);
		expect(listed?.description).toMatch(/sleep/i);
		// Nothing invented: the server knows of no modification time for a day
		// still being lived, so it claims none.
		expect(listed?.annotations).not.toHaveProperty("lastModified");
		expect(listed).not.toHaveProperty("lastModified");
	});

	it("answers a read with one JSON item echoing the URI, holding the day", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: TODAY_URI }),
		);

		// One item, not a bundle: the resource is one day's snapshot.
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0]).toMatchObject({
			uri: TODAY_URI,
			mimeType: "application/json",
		});
		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			// The cycle still running, carrying the strain accumulated so far, the
			// recovery scored for it, and the sleep that started it.
			cycle: OPEN_CYCLE,
			recovery_state: "SCORED",
			recovery: SCORED_RECOVERY,
			sleep: ONSET_SLEEP,
		});
	});

	it("answers a read with the very text its tool answers with", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const [toolText, readText] = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			async (client) => {
				const called = await client.callTool({
					name: "get_today_snapshot",
					arguments: {},
				});
				const read = await client.readResource({ uri: TODAY_URI });

				return [
					textOf((called.content as unknown[])[0]),
					textOf(read.contents[0]),
				];
			},
		);

		// Byte-identical, not merely equivalent: the two surfaces answer the one
		// canonical rendering of the snapshot, so neither can drift from the other.
		expect(readText).toBe(toolText);
	});

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: TODAY_URI }),
		);

		// Zero — immediately stale: the answer is bound to whoever the stored
		// login belongs to, a re-login can swap that account under an unchanged
		// URI, and this server has no way to call a cached copy back. Private:
		// it is one person's day.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	});
});

describe("today's own date, read as a day, over real stdio", () => {
	it("answers today's date with the very text whoop://today answers with", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const [todayText, dayText] = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			async (client) => {
				const today = await client.readResource({ uri: TODAY_URI });
				const day = await client.readResource({ uri: TODAY_DAY_URI });

				return [textOf(today.contents[0]), textOf(day.contents[0])];
			},
		);

		// Byte-identical, not merely equivalent, and from one connection to one
		// WHOOP: the day being lived is reachable by its date like any other, and
		// the two surfaces cannot disagree about it. The cycle still running has
		// no end yet, which neither the window it is matched in nor the morning
		// it is named by may be thrown by.
		expect(dayText).toBe(todayText);
	});

	it("answers today's date with the very text the today tool answers with", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const [toolText, dayText] = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			async (client) => {
				const called = await client.callTool({
					name: "get_today_snapshot",
					arguments: {},
				});
				const day = await client.readResource({ uri: TODAY_DAY_URI });

				return [
					textOf((called.content as unknown[])[0]),
					textOf(day.contents[0]),
				];
			},
		);

		// The third surface over the same day: a model that called the tool and a
		// user who attached the date are holding one rendering, not two readings
		// that happen to agree today.
		expect(dayText).toBe(toolText);
	});

	it("answers an open cycle WHOOP has filed no opening sleep for by its start date", async () => {
		// A night WHOOP has not filed yet — the state a morning spends before the
		// sleep that opened the running cycle is written.
		const whoopBaseUrl = await startFakeWhoop({ sleepListing: [] });
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: FALLBACK_DAY_URI }),
		);

		expect(JSON.parse(textOf(result.contents[0]))).toEqual({
			// With no wake to be named by, the cycle falls back to the date its own
			// start falls on — the evening of the 3rd, local — and is still the day
			// this server speaks for.
			cycle: OPEN_CYCLE,
			// The recovery join answers for the cycle whether or not its night is
			// filed, so the day carries the state that join reports.
			recovery_state: "SCORED",
			recovery: SCORED_RECOVERY,
			// And the sleep is a state of the day, not an error: WHOOP has no
			// record of it, so the day says so.
			sleep: null,
		});
	});
});

describe("a read of the today resource that cannot be answered", () => {
	it("names the login command when nothing is logged in", async () => {
		// A WHOOP that would answer, to make the point that the refusal is about
		// this machine's login rather than anything upstream.
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, TODAY_URI),
		);

		expect(refusal.code).toBe(-32603);
		// The one way out, and one an MCP client cannot drive itself: the user
		// has to run it in a terminal.
		expect(refusal.message).toContain("npx mcp-whoop login");
	});

	it("names the login command when the stored login cannot be read", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await corruptStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, TODAY_URI),
		);

		expect(refusal.code).toBe(-32603);
		// A store that cannot be trusted is not a state to explain to a model:
		// the login rewrites it whole, so it gets the same remedy as no login.
		expect(refusal.message).toContain("npx mcp-whoop login");
		// And nothing of the file itself — its contents are credentials.
		expect(refusal.message).not.toContain("an-acc");
	});

	it("relays an upstream failure with the token material scrubbed", async () => {
		// WHOOP's own words, quoting back the very credential the request was
		// signed with — the shape of body that turns a relayed message into a
		// credential leak if it is passed on as it arrived.
		const whoopBaseUrl = await startFailingWhoop({
			status: 403,
			body: {
				message: `The bearer token ${SEEDED_ACCESS_TOKEN} may not read cycles`,
			},
		});
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, TODAY_URI),
		);

		// A read that failed is an internal error to the protocol: the request
		// was well-formed and the resource exists — this server simply could not
		// answer it.
		expect(refusal.code).toBe(-32603);
		// Still a description someone can act on: which read failed, and that
		// WHOOP refused it.
		expect(refusal.message).toMatch(/cycles read/i);
		expect(refusal.message).toContain("403");
		// And nothing of the credential survives into it.
		expect(refusal.message).not.toContain(SEEDED_ACCESS_TOKEN);
		expect(refusal.message).toContain("[redacted]");
	});

	it("refuses an unknown whoop:// URI as invalid params, echoing it back", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedRead(client, UNKNOWN_URI),
		);

		// Not this server's refusal to write: the protocol library answers a
		// miss itself, and the 2026-07-28 revision requires invalid params — not
		// the -32002 earlier eras emitted — so this is pinned rather than
		// rebuilt. A client that asked for something this server does not serve
		// gets the URI it asked for back in the error data, which is how it
		// tells a miss apart from any other invalid-params refusal.
		expect(refusal.code).toBe(-32602);
		expect(refusal.data).toEqual({ uri: UNKNOWN_URI });
	});

	it("narrates the resource and the failure on the server's stderr", async () => {
		const whoopBaseUrl = await startFailingWhoop({
			status: 403,
			body: { message: "this login may not read cycles" },
		});
		const store = await temporaryStore();
		await seedStore(store);

		const { refusal, stderr } = await withBuiltStdioClient(
			{ store, whoopBaseUrl, stderr: "pipe" },
			async (client, _transport, stderr) => ({
				refusal: await refusedRead(client, TODAY_URI),
				stderr,
			}),
		);

		// Parity with what a failed tool call leaves in a host's log: the thing
		// that was asked for, and the very words the client was refused with —
		// at a level the default threshold shows, since a failure nobody
		// configured for is exactly what a reader goes looking for.
		await vi.waitFor(() => {
			expect(stderr()).toContain(TODAY_URI);
		});
		expect(stderr()).toContain(`[error] ${TODAY_URI}`);
		expect(stderr()).toContain(refusal.message);
	});
});

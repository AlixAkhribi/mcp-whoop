import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";
import { writeStoredTokens } from "@/whoop/auth/tokens/store";
import { buildCycle, buildSleep } from "../fixtures/whoop-records";
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

/** Where the two listings a completion is assembled from land upstream. */
const CYCLES_PATH = "/developer/v2/cycle";
const SLEEPS_PATH = "/developer/v2/activity/sleep";

/** The morning this WHOOP's newest cycle was woken into. */
const NEWEST_DAY = "2026-07-28";

const DAY_MS = 86_400_000;

/** A run of consecutive wake days ending at {@link NEWEST_DAY}, newest first. */
function daysBackFrom(count: number): string[] {
	const newest = Date.parse(`${NEWEST_DAY}T00:00:00.000Z`);

	return Array.from({ length: count }, (_, back) =>
		new Date(newest - back * DAY_MS).toISOString().slice(0, 10),
	);
}

/** The ten wake days these cases run against, newest first. */
const TEN_DAYS = daysBackFrom(10);

/** A date typed a little further: the year, the month, a digit of the day. */
const NARROWER_PREFIX = "2026-07-2";

/** The id WHOOP joins a seeded day's night back to its cycle by. */
function cycleIdOf(day: string): number {
	return 90_000 + Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

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

/** One request the server made upstream: what was asked for, and how narrowed. */
type UpstreamRequest = {
	readonly pathname: string;
	readonly query: URLSearchParams;
};

/**
 * A stand-in WHOOP holding a run of cycle-days and the nights that opened them,
 * paginating the way WHOOP does — and recording every request it was asked, so
 * a case can count what a conversation's typing cost it. It can also be flipped
 * into refusing everything and back, the way a real WHOOP goes down and
 * recovers mid-conversation.
 */
async function startCountingWhoop(days: readonly string[]): Promise<{
	baseUrl: string;
	requests: UpstreamRequest[];
	upstream: { refusing: boolean };
}> {
	const cycles = days.map((day) => buildCycle({ id: cycleIdOf(day), day }));
	const sleeps = days.map((day) =>
		buildSleep({ id: `sleep-${day}`, cycleId: cycleIdOf(day), day }),
	);
	const requests: UpstreamRequest[] = [];
	const upstream = { refusing: false };
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		requests.push({ pathname: url.pathname, query: url.searchParams });
		request.resume();
		request.on("end", () => {
			if (upstream.refusing) {
				response.writeHead(503, {
					"content-type": "application/json",
					connection: "close",
				});
				response.end(JSON.stringify({ message: "WHOOP is briefly down" }));

				return;
			}
			const collection =
				url.pathname === CYCLES_PATH
					? cycles
					: url.pathname === SLEEPS_PATH
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

	return { baseUrl: await listenOnLoopback(server), requests, upstream };
}

/** How many times one upstream collection was asked, by its path. */
function asked(requests: readonly UpstreamRequest[], pathname: string): number {
	return requests.filter((request) => request.pathname === pathname).length;
}

/**
 * Rewrites the store the way a re-login or another process's refresh does:
 * the same login, holding a different access token. The serving process reads
 * the store per ask, so its next completion runs under this token.
 */
async function rewriteStoreWith(
	store: string,
	accessToken: string,
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken,
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes: [...new Set([...DEFAULT_READ_SCOPES, OFFLINE_SCOPE])],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/** Asks for `{date}` completions with `value` typed so far. */
async function completedDates(
	client: Client,
	value: string,
): Promise<{ values: string[]; total?: number; hasMore?: boolean }> {
	const result = await client.complete({
		ref: { type: "ref/resource", uri: DAY_URI_TEMPLATE },
		argument: { name: DATE_VARIABLE, value },
	});

	return result.completion;
}

/** The JSON-RPC error a refused completion comes back as. */
type Refusal = { code: number; message: string };

/**
 * Completes `{date}` when the case means it to be refused, and reduces the
 * rejection to the JSON-RPC error the client was answered with. A completion
 * that is answered is itself the failure: the case asked to be refused.
 */
async function refusedCompletion(client: Client): Promise<Refusal> {
	try {
		await completedDates(client, "");
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(
		`completing ${DAY_URI_TEMPLATE} was answered rather than refused`,
	);
}

describe("what one conversation's typing costs WHOOP, over real stdio", () => {
	it("asks WHOOP once for three completions in one connection", async () => {
		const { baseUrl, requests } = await startCountingWhoop(TEN_DAYS);
		const store = await temporaryStore();
		await seedStore(store);

		await withBuiltStdioClient(
			{ store, whoopBaseUrl: baseUrl },
			async (client) => {
				// A user typing a date left to right: each keystroke narrows what is
				// still reachable, and each narrowing is its own ask on the wire.
				const wholeRun = await completedDates(client, "");
				const narrowedToMonth = await completedDates(client, "2026-07");
				const narrowedToDigit = await completedDates(client, NARROWER_PREFIX);

				// Every answer is still the truth the one listing established: the
				// memo spares WHOOP the asking, never reshapes what was asked.
				expect(wholeRun.values).toEqual(TEN_DAYS);
				expect(narrowedToMonth.values).toEqual(TEN_DAYS);
				expect(narrowedToDigit.values).toEqual(
					TEN_DAYS.filter((day) => day.startsWith(NARROWER_PREFIX)),
				);
				// And WHOOP heard about it once: one cycles listing and one sleeps
				// listing, however many keys were pressed.
				expect(asked(requests, CYCLES_PATH)).toBe(1);
				expect(asked(requests, SLEEPS_PATH)).toBe(1);
			},
		);
	});
});

describe("what a memo may never survive, over real stdio", () => {
	it("asks WHOOP again when the store holds a different access token", async () => {
		const { baseUrl, requests } = await startCountingWhoop(TEN_DAYS);
		const store = await temporaryStore();
		await seedStore(store);

		await withBuiltStdioClient(
			{ store, whoopBaseUrl: baseUrl },
			async (client) => {
				await completedDates(client, "");
				expect(asked(requests, CYCLES_PATH)).toBe(1);
				// A re-login or a token refresh lands in the store as a different
				// access token — possibly a different WHOOP account, whose days the
				// last listing says nothing about.
				await rewriteStoreWith(store, "an-access-token-rotated-since");

				const completion = await completedDates(client, "");

				// Still answered — this WHOOP holds the same days — but established
				// afresh under the token that now speaks for the login.
				expect(completion.values).toEqual(TEN_DAYS);
				expect(asked(requests, CYCLES_PATH)).toBe(2);
			},
		);
	});

	it("asks WHOOP again after a refused completion — nothing was memoized", async () => {
		const { baseUrl, requests, upstream } = await startCountingWhoop(TEN_DAYS);
		const store = await temporaryStore();
		await seedStore(store);

		await withBuiltStdioClient(
			{ store, whoopBaseUrl: baseUrl },
			async (client) => {
				// WHOOP down for the first ask: the completion is refused aloud, and
				// the refusal is nothing worth serving twice.
				upstream.refusing = true;
				const refusal = await refusedCompletion(client);
				expect(refusal.code).toBe(-32603);
				expect(asked(requests, CYCLES_PATH)).toBe(1);

				upstream.refusing = false;
				const completion = await completedDates(client, "");

				// WHOOP recovered, and was asked again: had the refusal been
				// memoized — as an error, or as an empty run of days — this
				// completion would refuse or offer nothing instead of the days.
				expect(completion.values).toEqual(TEN_DAYS);
				expect(asked(requests, CYCLES_PATH)).toBe(2);
			},
		);
	});

	it("asks WHOOP afresh for a day read right after a completion", async () => {
		const { baseUrl, requests } = await startCountingWhoop(TEN_DAYS);
		const store = await temporaryStore();
		await seedStore(store);

		await withBuiltStdioClient(
			{ store, whoopBaseUrl: baseUrl },
			async (client) => {
				// A completion just answered: the memo now holds the very days a read
				// of one of them would be assembled from.
				const completion = await completedDates(client, "");
				expect(completion.values).toEqual(TEN_DAYS);
				expect(asked(requests, CYCLES_PATH)).toBe(1);

				const result = await client.readResource({
					uri: `whoop://day/${NEWEST_DAY}`,
				});

				// The read answered the day — and went upstream to do it: a read
				// promises a zero lifetime, so what a completion remembered a moment
				// ago is never what a member is answered from.
				expect(result.contents).toHaveLength(1);
				const cyclesAsks = requests.filter(
					(request) => request.pathname === CYCLES_PATH,
				);
				expect(cyclesAsks).toHaveLength(2);
				// And it asked as a read asks: for its own bounded window of instants,
				// not for the listing the completion memoized.
				expect(cyclesAsks[1].query.get("start")).not.toBeNull();
				expect(cyclesAsks[1].query.get("end")).not.toBeNull();
				expect(asked(requests, SLEEPS_PATH)).toBe(2);
			},
		);
	});
});

import { Client } from "@modelcontextprotocol/client";
import {
	InMemoryTransport,
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { datesStartingWith } from "@/whoop/reads/recent-days";

/** The most a `completion/complete` result may carry, by the specification. */
const MAX_COMPLETION_VALUES = 100;

/** The family this pins the bound for, named exactly as the server serves it. */
const DAY_URI_TEMPLATE = "whoop://day/{date}";

const DAY_MS = 86_400_000;

/**
 * A run of consecutive wake days, newest first — longer than a completion may
 * carry, which the thirty a day read hands over never is. The bound being
 * pinned is the protocol's, not the read's, so the days are made here rather
 * than fetched: what has to hold is that the narrowing passes every match on
 * and lets the answer be cut where the protocol cuts it.
 */
function longRunOfDays(count: number): string[] {
	const newest = Date.parse("2026-07-28T00:00:00.000Z");

	return Array.from({ length: count }, (_, back) =>
		new Date(newest - back * DAY_MS).toISOString().slice(0, 10),
	);
}

/** More matching days than a single completion is allowed to answer with. */
const MANY_DAYS = longRunOfDays(150);

/** The prefix every one of them starts with — a narrowing that hides nothing. */
const SHARED_PREFIX = "20";

/**
 * A server offering those days for `{date}` through the very narrowing the day
 * template completes with, and a client connected to it in memory. No stdio
 * and no WHOOP: what is under test is the seam between this server's narrowing
 * and the protocol library's shaping of what comes out of it.
 */
async function completeAgainst(
	days: readonly string[],
	typed: string,
): Promise<{ values: string[]; total?: number; hasMore?: boolean }> {
	const server = new McpServer(
		{ name: "completion-bounds", version: "0.0.0" },
		{ capabilities: { resources: { listChanged: false }, completions: {} } },
	);
	server.registerResource(
		"whoop_day",
		new ResourceTemplate(DAY_URI_TEMPLATE, {
			list: undefined,
			complete: { date: (value: string) => datesStartingWith(days, value) },
		}),
		{},
		() => {
			throw new Error("this case completes a date, it never reads one");
		},
	);
	const client = new Client({ name: "completion-bounds", version: "0.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	try {
		const result = await client.complete({
			ref: { type: "ref/resource", uri: DAY_URI_TEMPLATE },
			argument: { name: "date", value: typed },
		});

		return result.completion;
	} finally {
		await client.close();
		await server.close();
	}
}

describe("how many days one completion may carry", () => {
	it("answers a hundred and says there are more", async () => {
		const completion = await completeAgainst(MANY_DAYS, SHARED_PREFIX);

		// The Given: every one of the hundred and fifty days matches, so the
		// narrowing hides none of them and hands the whole run on — uncapped, so
		// the count that reaches the client is the count of matches.
		expect(datesStartingWith(MANY_DAYS, SHARED_PREFIX)).toHaveLength(
			MANY_DAYS.length,
		);
		// And the answer is cut where the protocol cuts it: a hundred values, the
		// true total beside them, and `hasMore` saying the list was cut. Capping
		// the narrowing instead would make `total` count the cut list and tell a
		// client there was nothing more when there was.
		expect(completion.values).toHaveLength(MAX_COMPLETION_VALUES);
		expect(completion.values).toEqual(
			MANY_DAYS.slice(0, MAX_COMPLETION_VALUES),
		);
		expect(completion.total).toBe(MANY_DAYS.length);
		expect(completion.hasMore).toBe(true);
	});
});

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchCyclePage, type WhoopCycle } from "@/api/data/cycles";
import { fetchRecoveryPage, type WhoopRecovery } from "@/api/data/recoveries";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import {
	recoverySummarySchema,
	summarizeRecoveries,
} from "@/summaries/recovery";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";
import { requireStoredLogin } from "./stored-login";

/** A week, the span the question "how is my recovery lately" usually means. */
const DEFAULT_DAYS = 7;

/**
 * As far back as a summary reaches; longer windows belong to `list_cycles` and
 * `list_recoveries`.
 */
const MAX_DAYS = 30;

/** WHOOP's largest page, so a week of days costs one round trip per listing. */
const PAGE_LIMIT = 25;

/**
 * How many pages a walk will follow before it stops. A month of days fits in
 * two full pages; the ceiling is what keeps a next_token that never ends from
 * walking forever.
 */
const MAX_PAGES = 8;

/**
 * The `get_recovery_summary` input: a count of the most recent days, never a
 * pair of instants. The bounds live in the integer itself, so a call outside
 * them is refused by the advertised schema before anything is asked of WHOOP.
 */
const getRecoverySummaryInputSchema = z.object({
	days: z
		.int()
		.min(1)
		.max(MAX_DAYS)
		.default(DEFAULT_DAYS)
		.describe(
			`How many of the most recent days to summarize (1-${MAX_DAYS}, default ${DEFAULT_DAYS}).`,
		),
});

/** One page of a WHOOP collection, as every paginated listing answers. */
type Page<T> = {
	records: T[];
	next_token?: string | null;
};

/**
 * Walks a WHOOP collection from its newest record back — the open cycle
 * included — following the next_token chain only as far as the asked-for days
 * require, and stopping early on the last page WHOOP has.
 *
 * Both listings this summary reads run newest first, and a cycle has at most
 * one recovery, so as many records as there are days in the window always reach
 * back at least as far as the window does — whatever the join then pairs up.
 */
async function collectRecent<T>(
	days: number,
	readPage: (nextToken: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
	const collected: T[] = [];
	let nextToken: string | undefined;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		// Sequential by nature: each page is addressed by the token the one
		// before it named.
		const answered = await readPage(nextToken);
		collected.push(...answered.records);

		if (collected.length >= days || !answered.next_token) {
			break;
		}
		nextToken = answered.next_token;
	}

	return collected;
}

/** The most recent cycles — the days this summary speaks for. */
function fetchCyclesFor(
	accessToken: string,
	days: number,
): Promise<WhoopCycle[]> {
	return collectRecent(days, (nextToken) =>
		fetchCyclePage(accessToken, { limit: PAGE_LIMIT, nextToken }),
	);
}

/** The recoveries that reach back over those days, to be joined to them. */
function fetchRecoveriesFor(
	accessToken: string,
	days: number,
): Promise<WhoopRecovery[]> {
	return collectRecent(days, (nextToken) =>
		fetchRecoveryPage(accessToken, { limit: PAGE_LIMIT, nextToken }),
	);
}

/** Registers the `get_recovery_summary` tool on a server instance. */
export function registerGetRecoverySummaryTool(server: McpServer): void {
	server.registerTool(
		"get_recovery_summary",
		{
			title: "WHOOP recovery summary",
			description:
				"Summarizes the most recent days of WHOOP recovery for the user this server is logged in as (7 by default, 30 at most): how many of those days WHOOP holds and has scored a recovery for, the mean, low and high of recovery score, heart rate variability and resting heart rate across them, and one row per day, newest first. A day is one physiological cycle, labeled by the cycle's start in the user's own timezone.",
			inputSchema: getRecoverySummaryInputSchema,
			outputSchema: recoverySummarySchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_recovery_summary", async ({ days }) => {
			const tokens = await requireStoredLogin();

			const summary = await withValidAccessToken(
				tokens,
				async (accessToken) => {
					const cycles = await fetchCyclesFor(accessToken, days);
					const recoveries = await fetchRecoveriesFor(accessToken, days);

					return summarizeRecoveries(cycles, recoveries, days);
				},
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(summary, null, "\t") },
				],
				structuredContent: summary,
			};
		}),
	);
}

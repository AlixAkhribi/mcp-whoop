import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchSleepPage, type WhoopSleep } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { sleepSummarySchema, summarizeSleeps } from "@/summaries/sleep";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";
import { requireStoredLogin } from "./stored-login";

/** A week, the span the question "how did I sleep lately" usually means. */
const DEFAULT_DAYS = 7;

/** As far back as a summary reaches; longer windows belong to `list_sleeps`. */
const MAX_DAYS = 30;

/** WHOOP's largest page, so a week of nights costs one round trip. */
const PAGE_LIMIT = 25;

/**
 * How many pages a walk will follow before it stops. A month of nights fits in
 * two full pages; the ceiling is what keeps a chain of nap-only pages — or a
 * next_token that never ends — from walking forever.
 */
const MAX_PAGES = 8;

/**
 * The `get_sleep_summary` input: a count of the most recent nights, never a
 * pair of instants. The bounds live in the integer itself, so a call outside
 * them is refused by the advertised schema before anything is asked of WHOOP.
 */
const getSleepSummaryInputSchema = z.object({
	days: z
		.int()
		.min(1)
		.max(MAX_DAYS)
		.default(DEFAULT_DAYS)
		.describe(
			`How many of the most recent nights to summarize (1-${MAX_DAYS}, default ${DEFAULT_DAYS}).`,
		),
});

/**
 * Walks WHOOP's sleep collection from the newest sleep back, following the
 * next_token chain only as far as the asked-for nights require, and stopping
 * early on the last page WHOOP has.
 */
async function fetchSleepsFor(
	accessToken: string,
	days: number,
): Promise<WhoopSleep[]> {
	const collected: WhoopSleep[] = [];
	let nextToken: string | undefined;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		// Sequential by nature: each page is addressed by the token the one
		// before it named.
		const answered = await fetchSleepPage(accessToken, {
			limit: PAGE_LIMIT,
			nextToken,
		});
		collected.push(...answered.records);

		const nights = collected.filter((sleep) => !sleep.nap).length;
		if (nights >= days || !answered.next_token) {
			break;
		}
		nextToken = answered.next_token;
	}

	return collected;
}

/** Registers the `get_sleep_summary` tool on a server instance. */
export function registerGetSleepSummaryTool(server: McpServer): void {
	server.registerTool(
		"get_sleep_summary",
		{
			title: "WHOOP sleep summary",
			description:
				"Summarizes the most recent nights of WHOOP sleep for the user this server is logged in as (7 by default, 30 at most): how many of those nights WHOOP holds and has scored, the mean, low and high of sleep performance, time in bed and sleep efficiency across them, the sleep stage totals beneath them, and one row per night, newest first. Naps are counted apart and never averaged into the nightly figures.",
			inputSchema: getSleepSummaryInputSchema,
			outputSchema: sleepSummarySchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_sleep_summary", async ({ days }) => {
			const tokens = await requireStoredLogin();

			const sleeps = await withValidAccessToken(tokens, (accessToken) =>
				fetchSleepsFor(accessToken, days),
			);
			const summary = summarizeSleeps(sleeps, days);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(summary, null, "\t") },
				],
				structuredContent: summary,
			};
		}),
	);
}

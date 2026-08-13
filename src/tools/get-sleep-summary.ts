import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
	answerSleepSummary,
	SLEEP_SUMMARY_DEFAULT_DAYS,
	SLEEP_SUMMARY_MAX_DAYS,
	sleepSummarySchema,
} from "@/summaries/sleep";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * The `get_sleep_summary` input: a count of the most recent nights, never a
 * pair of instants. The bounds live in the integer itself, so a call outside
 * them is refused by the advertised schema before anything is asked of WHOOP.
 *
 * The default is the shared path's own, not a number repeated here: a call that
 * names no days and a read of `whoop://sleep/last-week` are the same week.
 */
const getSleepSummaryInputSchema = z.object({
	days: z
		.int()
		.min(1)
		.max(SLEEP_SUMMARY_MAX_DAYS)
		.default(SLEEP_SUMMARY_DEFAULT_DAYS)
		.describe(
			`How many of the most recent nights to summarize (1-${SLEEP_SUMMARY_MAX_DAYS}, default ${SLEEP_SUMMARY_DEFAULT_DAYS}).`,
		),
});

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
			const { summary, json } = await answerSleepSummary(days);

			return {
				content: [{ type: "text" as const, text: json }],
				structuredContent: summary,
			};
		}),
	);
}

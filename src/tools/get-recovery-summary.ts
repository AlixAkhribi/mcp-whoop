import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
	answerRecoverySummary,
	RECOVERY_SUMMARY_DEFAULT_DAYS,
	RECOVERY_SUMMARY_MAX_DAYS,
	recoverySummarySchema,
} from "@/summaries/recovery";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * The `get_recovery_summary` input: a count of the most recent days, never a
 * pair of instants. The bounds live in the integer itself, so a call outside
 * them is refused by the advertised schema before anything is asked of WHOOP.
 *
 * The default is the shared path's own, not a number repeated here: a call that
 * names no days and a read of `whoop://recovery/last-week` are the same week.
 */
const getRecoverySummaryInputSchema = z.object({
	days: z
		.int()
		.min(1)
		.max(RECOVERY_SUMMARY_MAX_DAYS)
		.default(RECOVERY_SUMMARY_DEFAULT_DAYS)
		.describe(
			`How many of the most recent days to summarize (1-${RECOVERY_SUMMARY_MAX_DAYS}, default ${RECOVERY_SUMMARY_DEFAULT_DAYS}).`,
		),
});

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
			const { summary, json } = await answerRecoverySummary(days);

			return {
				content: [{ type: "text" as const, text: json }],
				structuredContent: summary,
			};
		}),
	);
}

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonToolResult } from "@/json";
import {
	readSleepSummary,
	SLEEP_SUMMARY_DEFAULT_DAYS,
	SLEEP_SUMMARY_MAX_DAYS,
	sleepSummarySchema,
} from "@/whoop/reads/sleep-summary";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getSleepSummaryInputSchema = z.strictObject({
	days: z
		.int()
		.min(1)
		.max(SLEEP_SUMMARY_MAX_DAYS)
		.default(SLEEP_SUMMARY_DEFAULT_DAYS)
		.describe(
			`How many of the most recent nights to summarize (1-${SLEEP_SUMMARY_MAX_DAYS}, default ${SLEEP_SUMMARY_DEFAULT_DAYS}).`,
		),
});

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
		observedTool("get_sleep_summary", async ({ days }, ctx: ServerContext) => {
			const summary = await readSleepSummary({
				days,
				signal: ctx.mcpReq.signal,
			});

			return jsonToolResult(summary);
		}),
	);
}

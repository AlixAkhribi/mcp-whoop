import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonToolResult } from "@/json";
import {
	RECOVERY_SUMMARY_DEFAULT_DAYS,
	RECOVERY_SUMMARY_MAX_DAYS,
	readRecoverySummary,
	recoverySummarySchema,
} from "@/whoop/reads/recovery-summary";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getRecoverySummaryInputSchema = z.strictObject({
	days: z
		.int()
		.min(1)
		.max(RECOVERY_SUMMARY_MAX_DAYS)
		.default(RECOVERY_SUMMARY_DEFAULT_DAYS)
		.describe(
			`How many of the most recent days to summarize (1-${RECOVERY_SUMMARY_MAX_DAYS}, default ${RECOVERY_SUMMARY_DEFAULT_DAYS}).`,
		),
});

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
		observedTool(
			"get_recovery_summary",
			async ({ days }, ctx: ServerContext) => {
				const summary = await readRecoverySummary({
					days,
					signal: ctx.mcpReq.signal,
				});

				return jsonToolResult(summary);
			},
		),
	);
}

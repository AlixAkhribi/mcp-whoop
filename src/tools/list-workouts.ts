import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchWorkoutPage, workoutPageSchema } from "@/api/data/workouts";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";
import { requireStoredLogin } from "./stored-login";

/**
 * The `list_workouts` input, mirroring the query WHOOP's
 * `GET /v2/activity/workout` documents — same names, same constraints — so the
 * arguments a model reads in WHOOP's documentation are the arguments this tool
 * takes.
 */
const listWorkoutsInputSchema = z.object({
	start: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only workouts that occurred during or after (inclusive) this ISO 8601 time.",
		),
	end: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only workouts that intersect this ISO 8601 time or ended before (exclusive) it. Defaults to now.",
		),
	limit: z
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe("How many workouts to return at most (default 10, max 25)."),
	nextToken: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The next_token of the previous page, to get the page after it. Omit for the first page.",
		),
});

/** Registers the `list_workouts` tool on a server instance. */
export function registerListWorkoutsTool(server: McpServer): void {
	server.registerTool(
		"list_workouts",
		{
			title: "WHOOP workouts",
			description:
				"Lists the WHOOP workouts of the user this server is logged in as, newest first, one page at a time. Each workout names the sport WHOOP recognised it as; sports that record no distance or altitude report those as null. The returned next_token, when it is not null, fetches the page after it.",
			inputSchema: listWorkoutsInputSchema,
			outputSchema: workoutPageSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("list_workouts", async (query) => {
			const tokens = await requireStoredLogin();

			const page = await withValidAccessToken(tokens, (accessToken) =>
				fetchWorkoutPage(accessToken, query),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(page, null, "\t") },
				],
				structuredContent: page,
			};
		}),
	);
}

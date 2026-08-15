import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { jsonToolResult } from "@/json";
import { fetchWorkoutPage, workoutPageSchema } from "@/whoop/api/data/workouts";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { listInputSchemaFor } from "./list-input";
import { observedTool } from "./observed";

const listWorkoutsInputSchema = listInputSchemaFor("workouts");

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
		observedTool("list_workouts", async (query, ctx: ServerContext) => {
			const page = await withAuthorizedWhoopAccess(
				[READ_SCOPES.workout],
				({ accessToken, signal }) =>
					fetchWorkoutPage(accessToken, query, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(page);
		}),
	);
}

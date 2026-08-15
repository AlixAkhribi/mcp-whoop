import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import { fetchWorkout, workoutSchema } from "@/whoop/api/data/workouts";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getWorkoutInputSchema = z.strictObject({
	workoutId: z.uuid().describe("The UUID of the workout to retrieve."),
});

export function registerGetWorkoutTool(server: McpServer): void {
	server.registerTool(
		"get_workout",
		{
			title: "WHOOP workout by id",
			description:
				"Reads one WHOOP workout by its id, for the user this server is logged in as. The workout names the sport WHOOP recognised it as; sports that record no distance or altitude report those as null.",
			inputSchema: getWorkoutInputSchema,
			outputSchema: workoutSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_workout", async ({ workoutId }, ctx: ServerContext) => {
			const workout = await withAuthorizedWhoopAccess(
				[READ_SCOPES.workout],
				({ accessToken, signal }) =>
					fetchWorkout(accessToken, workoutId, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(workout);
		}),
	);
}

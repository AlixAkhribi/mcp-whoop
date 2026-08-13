import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchWorkout, workoutSchema } from "@/api/data/workouts";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireStoredLogin } from "@/auth/tokens/stored-login";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * The `get_workout` input: the id of the workout to read, named as WHOOP's
 * `GET /v2/activity/workout/{workoutId}` names its path parameter, so the
 * argument a model reads in WHOOP's documentation is the argument this tool
 * takes. v2 keys a workout by a UUID string, not by the integer v1 used.
 */
const getWorkoutInputSchema = z.object({
	workoutId: z.uuid().describe("The UUID of the workout to retrieve."),
});

/** Registers the `get_workout` tool on a server instance. */
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
		observedTool("get_workout", async ({ workoutId }) => {
			const tokens = await requireStoredLogin();

			const workout = await withValidAccessToken(tokens, (accessToken) =>
				fetchWorkout(accessToken, workoutId),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(workout, null, "\t") },
				],
				structuredContent: workout,
			};
		}),
	);
}

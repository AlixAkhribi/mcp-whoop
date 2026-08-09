import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchCycleSleep, sleepSchema } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";
import { requireStoredLogin } from "./stored-login";

/**
 * The `get_cycle_sleep` input: the id of the cycle whose sleep to read, named
 * as WHOOP's `GET /v2/cycle/{cycleId}/sleep` names its path parameter, so the
 * argument a model reads in WHOOP's documentation is the argument this tool
 * takes.
 */
const getCycleSleepInputSchema = z.object({
	cycleId: z.int().describe("The id of the cycle whose sleep to retrieve."),
});

/** Registers the `get_cycle_sleep` tool on a server instance. */
export function registerGetCycleSleepTool(server: McpServer): void {
	server.registerTool(
		"get_cycle_sleep",
		{
			title: "WHOOP sleep of a cycle",
			description:
				"Reads the WHOOP sleep that started one physiological cycle, by the cycle's id, for the user this server is logged in as.",
			inputSchema: getCycleSleepInputSchema,
			outputSchema: sleepSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_cycle_sleep", async ({ cycleId }) => {
			const tokens = await requireStoredLogin();

			const sleep = await withValidAccessToken(tokens, (accessToken) =>
				fetchCycleSleep(accessToken, cycleId),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(sleep, null, "\t") },
				],
				structuredContent: sleep,
			};
		}),
	);
}

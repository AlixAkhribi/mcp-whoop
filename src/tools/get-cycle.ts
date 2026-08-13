import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { cycleSchema, fetchCycle } from "@/api/data/cycles";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireStoredLogin } from "@/auth/tokens/stored-login";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * The `get_cycle` input: the id of the cycle to read, named as WHOOP's
 * `GET /v2/cycle/{cycleId}` names its path parameter, so the argument a model
 * reads in WHOOP's documentation is the argument this tool takes.
 */
const getCycleInputSchema = z.object({
	cycleId: z.int().describe("The id of the cycle to retrieve."),
});

/** Registers the `get_cycle` tool on a server instance. */
export function registerGetCycleTool(server: McpServer): void {
	server.registerTool(
		"get_cycle",
		{
			title: "WHOOP cycle by id",
			description:
				"Reads one WHOOP physiological cycle by its id, for the user this server is logged in as.",
			inputSchema: getCycleInputSchema,
			outputSchema: cycleSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_cycle", async ({ cycleId }) => {
			const tokens = await requireStoredLogin();

			const cycle = await withValidAccessToken(tokens, (accessToken) =>
				fetchCycle(accessToken, cycleId),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(cycle, null, "\t") },
				],
				structuredContent: cycle,
			};
		}),
	);
}

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import { cycleSchema, fetchCycle } from "@/whoop/api/data/cycles";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getCycleInputSchema = z.strictObject({
	cycleId: z.int().describe("The id of the cycle to retrieve."),
});

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
		observedTool("get_cycle", async ({ cycleId }, ctx: ServerContext) => {
			const cycle = await withAuthorizedWhoopAccess(
				[READ_SCOPES.cycles],
				({ accessToken, signal }) =>
					fetchCycle(accessToken, cycleId, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(cycle);
		}),
	);
}

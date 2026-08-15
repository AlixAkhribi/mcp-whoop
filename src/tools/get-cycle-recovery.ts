import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import {
	fetchCycleRecovery,
	recoverySchema,
} from "@/whoop/api/data/recoveries";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getCycleRecoveryInputSchema = z.strictObject({
	cycleId: z.int().describe("The id of the cycle whose recovery to retrieve."),
});

export function registerGetCycleRecoveryTool(server: McpServer): void {
	server.registerTool(
		"get_cycle_recovery",
		{
			title: "WHOOP recovery of a cycle",
			description:
				"Reads the WHOOP recovery scored for one physiological cycle, by the cycle's id, for the user this server is logged in as.",
			inputSchema: getCycleRecoveryInputSchema,
			outputSchema: recoverySchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool(
			"get_cycle_recovery",
			async ({ cycleId }, ctx: ServerContext) => {
				const recovery = await withAuthorizedWhoopAccess(
					[READ_SCOPES.recovery],
					({ accessToken, signal }) =>
						fetchCycleRecovery(accessToken, cycleId, { signal }),
					{ signal: ctx.mcpReq.signal },
				);

				return jsonToolResult(recovery);
			},
		),
	);
}

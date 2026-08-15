import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import { fetchCycleSleep, sleepSchema } from "@/whoop/api/data/sleeps";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getCycleSleepInputSchema = z.strictObject({
	cycleId: z.int().describe("The id of the cycle whose sleep to retrieve."),
});

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
		observedTool("get_cycle_sleep", async ({ cycleId }, ctx: ServerContext) => {
			const sleep = await withAuthorizedWhoopAccess(
				[READ_SCOPES.sleep],
				({ accessToken, signal }) =>
					fetchCycleSleep(accessToken, cycleId, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(sleep);
		}),
	);
}

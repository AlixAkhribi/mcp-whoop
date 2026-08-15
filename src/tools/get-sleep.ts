import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import { fetchSleep, sleepSchema } from "@/whoop/api/data/sleeps";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getSleepInputSchema = z.strictObject({
	sleepId: z.uuid().describe("The UUID of the sleep to retrieve."),
});

export function registerGetSleepTool(server: McpServer): void {
	server.registerTool(
		"get_sleep",
		{
			title: "WHOOP sleep by id",
			description:
				"Reads one WHOOP sleep by its id, for the user this server is logged in as. Naps are read the same way as nights and are marked with nap: true.",
			inputSchema: getSleepInputSchema,
			outputSchema: sleepSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_sleep", async ({ sleepId }, ctx: ServerContext) => {
			const sleep = await withAuthorizedWhoopAccess(
				[READ_SCOPES.sleep],
				({ accessToken, signal }) =>
					fetchSleep(accessToken, sleepId, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(sleep);
		}),
	);
}

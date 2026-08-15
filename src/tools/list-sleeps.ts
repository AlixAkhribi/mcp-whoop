import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { jsonToolResult } from "@/json";
import { fetchSleepPage, sleepPageSchema } from "@/whoop/api/data/sleeps";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { listInputSchemaFor } from "./list-input";
import { observedTool } from "./observed";

const listSleepsInputSchema = listInputSchemaFor("sleeps");

export function registerListSleepsTool(server: McpServer): void {
	server.registerTool(
		"list_sleeps",
		{
			title: "WHOOP sleeps",
			description:
				"Lists the WHOOP sleeps of the user this server is logged in as, newest first, one page at a time. Naps are listed alongside nights and are marked with nap: true. The returned next_token, when it is not null, fetches the page after it.",
			inputSchema: listSleepsInputSchema,
			outputSchema: sleepPageSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("list_sleeps", async (query, ctx: ServerContext) => {
			const page = await withAuthorizedWhoopAccess(
				[READ_SCOPES.sleep],
				({ accessToken, signal }) =>
					fetchSleepPage(accessToken, query, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(page);
		}),
	);
}

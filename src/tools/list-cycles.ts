import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { jsonToolResult } from "@/json";
import { cyclePageSchema, fetchCyclePage } from "@/whoop/api/data/cycles";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { listInputSchemaFor } from "./list-input";
import { observedTool } from "./observed";

const listCyclesInputSchema = listInputSchemaFor("cycles");

export function registerListCyclesTool(server: McpServer): void {
	server.registerTool(
		"list_cycles",
		{
			title: "WHOOP cycles",
			description:
				"Lists the WHOOP physiological cycles of the user this server is logged in as, newest first, one page at a time. The returned next_token, when it is not null, fetches the page after it.",
			inputSchema: listCyclesInputSchema,
			outputSchema: cyclePageSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("list_cycles", async (query, ctx: ServerContext) => {
			const page = await withAuthorizedWhoopAccess(
				[READ_SCOPES.cycles],
				({ accessToken, signal }) =>
					fetchCyclePage(accessToken, query, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(page);
		}),
	);
}

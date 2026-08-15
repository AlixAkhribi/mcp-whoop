import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { jsonToolResult } from "@/json";
import {
	fetchRecoveryPage,
	recoveryPageSchema,
} from "@/whoop/api/data/recoveries";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { READ_SCOPES } from "@/whoop/auth/tokens/scopes";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { listInputSchemaFor } from "./list-input";
import { observedTool } from "./observed";

const listRecoveriesInputSchema = listInputSchemaFor("recoveries");

export function registerListRecoveriesTool(server: McpServer): void {
	server.registerTool(
		"list_recoveries",
		{
			title: "WHOOP recoveries",
			description:
				"Lists the WHOOP recoveries of the user this server is logged in as, newest first, one page at a time. A recovery is keyed by the cycle it scores and the sleep it was computed from. The returned next_token, when it is not null, fetches the page after it.",
			inputSchema: listRecoveriesInputSchema,
			outputSchema: recoveryPageSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("list_recoveries", async (query, ctx: ServerContext) => {
			const page = await withAuthorizedWhoopAccess(
				[READ_SCOPES.recovery],
				({ accessToken, signal }) =>
					fetchRecoveryPage(accessToken, query, { signal }),
				{ signal: ctx.mcpReq.signal },
			);

			return jsonToolResult(page);
		}),
	);
}

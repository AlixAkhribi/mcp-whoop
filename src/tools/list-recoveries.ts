import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchRecoveryPage, recoveryPageSchema } from "@/api/data/recoveries";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";
import { requireStoredLogin } from "./stored-login";

/**
 * The `list_recoveries` input, mirroring the query WHOOP's `GET /v2/recovery`
 * documents — same names, same constraints — so the arguments a model reads in
 * WHOOP's documentation are the arguments this tool takes.
 */
const listRecoveriesInputSchema = z.object({
	start: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only recoveries that occurred during or after (inclusive) this ISO 8601 time.",
		),
	end: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only recoveries that intersect this ISO 8601 time or ended before (exclusive) it. Defaults to now.",
		),
	limit: z
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe("How many recoveries to return at most (default 10, max 25)."),
	nextToken: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The next_token of the previous page, to get the page after it. Omit for the first page.",
		),
});

/** Registers the `list_recoveries` tool on a server instance. */
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
		observedTool("list_recoveries", async (query) => {
			const tokens = await requireStoredLogin();

			const page = await withValidAccessToken(tokens, (accessToken) =>
				fetchRecoveryPage(accessToken, query),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(page, null, "\t") },
				],
				structuredContent: page,
			};
		}),
	);
}

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { cyclePageSchema, fetchCyclePage } from "@/api/data/cycles";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { redactingErrors } from "@/lib/redaction";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { requireStoredLogin } from "./stored-login";

/**
 * The `list_cycles` input, mirroring the query WHOOP's `GET /v2/cycle`
 * documents — same names, same constraints — so the arguments a model reads in
 * WHOOP's documentation are the arguments this tool takes.
 */
const listCyclesInputSchema = z.object({
	start: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only cycles that occurred during or after (inclusive) this ISO 8601 time.",
		),
	end: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only cycles that intersect this ISO 8601 time or ended before (exclusive) it. Defaults to now.",
		),
	limit: z
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe("How many cycles to return at most (default 10, max 25)."),
	nextToken: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The next_token of the previous page, to get the page after it. Omit for the first page.",
		),
});

/** Registers the `list_cycles` tool on a server instance. */
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
		redactingErrors(async (query) => {
			const tokens = await requireStoredLogin();

			const page = await withValidAccessToken(tokens, (accessToken) =>
				fetchCyclePage(accessToken, query),
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

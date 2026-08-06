import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchSleepPage, sleepPageSchema } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { redactingErrors } from "@/lib/redaction";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { requireStoredLogin } from "./stored-login";

/**
 * The `list_sleeps` input, mirroring the query WHOOP's
 * `GET /v2/activity/sleep` documents — same names, same constraints — so the
 * arguments a model reads in WHOOP's documentation are the arguments this tool
 * takes.
 */
const listSleepsInputSchema = z.object({
	start: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only sleeps that occurred during or after (inclusive) this ISO 8601 time.",
		),
	end: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only sleeps that intersect this ISO 8601 time or ended before (exclusive) it. Defaults to now.",
		),
	limit: z
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe("How many sleeps to return at most (default 10, max 25)."),
	nextToken: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The next_token of the previous page, to get the page after it. Omit for the first page.",
		),
});

/** Registers the `list_sleeps` tool on a server instance. */
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
		redactingErrors(async (query) => {
			const tokens = await requireStoredLogin();

			const page = await withValidAccessToken(tokens, (accessToken) =>
				fetchSleepPage(accessToken, query),
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

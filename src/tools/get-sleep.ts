import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchSleep, sleepSchema } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireStoredLogin } from "@/auth/tokens/stored-login";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * The `get_sleep` input: the id of the sleep to read, named as WHOOP's
 * `GET /v2/activity/sleep/{sleepId}` names its path parameter, so the argument
 * a model reads in WHOOP's documentation is the argument this tool takes. v2
 * keys a sleep by a UUID string, not by the integer v1 used.
 */
const getSleepInputSchema = z.object({
	sleepId: z.uuid().describe("The UUID of the sleep to retrieve."),
});

/** Registers the `get_sleep` tool on a server instance. */
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
		observedTool("get_sleep", async ({ sleepId }) => {
			const tokens = await requireStoredLogin();

			const sleep = await withValidAccessToken(tokens, (accessToken) =>
				fetchSleep(accessToken, sleepId),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(sleep, null, "\t") },
				],
				structuredContent: sleep,
			};
		}),
	);
}

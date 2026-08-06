import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchCycleRecovery, recoverySchema } from "@/api/data/recoveries";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { redactingErrors } from "@/lib/redaction";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { requireStoredLogin } from "./stored-login";

/**
 * The `get_cycle_recovery` input: the id of the cycle whose recovery to read,
 * named as WHOOP's `GET /v2/cycle/{cycleId}/recovery` names its path parameter,
 * so the argument a model reads in WHOOP's documentation is the argument this
 * tool takes.
 */
const getCycleRecoveryInputSchema = z.object({
	cycleId: z.int().describe("The id of the cycle whose recovery to retrieve."),
});

/** Registers the `get_cycle_recovery` tool on a server instance. */
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
		redactingErrors(async ({ cycleId }) => {
			const tokens = await requireStoredLogin();

			const recovery = await withValidAccessToken(tokens, (accessToken) =>
				fetchCycleRecovery(accessToken, cycleId),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(recovery, null, "\t") },
				],
				structuredContent: recovery,
			};
		}),
	);
}

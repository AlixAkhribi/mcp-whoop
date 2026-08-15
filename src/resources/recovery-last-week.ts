import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { formatJson } from "@/json";
import { readRecoverySummary } from "@/whoop/reads/recovery-summary";
import { observedResource } from "./observed";
import {
	RESOURCE_ANNOTATIONS,
	RESOURCE_CACHE_HINT,
	RESOURCE_MIME_TYPE,
} from "./policy";

const RECOVERY_LAST_WEEK_URI = "whoop://recovery/last-week";

export function registerRecoveryLastWeekResource(server: McpServer): void {
	server.registerResource(
		"whoop_recovery_last_week",
		RECOVERY_LAST_WEEK_URI,
		{
			title: "WHOOP recovery, last week",
			description:
				'The last seven days of WHOOP recovery, as a digest to attach to a conversation: how many of those days WHOOP holds and has scored a recovery for, the mean, low and high of recovery score, heart rate variability and resting heart rate across them, and one row per day, newest first. The same answer the "get_recovery_summary" tool gives when it is asked for no particular range. Read it again for fresher numbers — the newest day is still being scored.',
			mimeType: RESOURCE_MIME_TYPE,
			// No `lastModified`: the week reaches into the cycle now running, which
			// WHOOP is still scoring, so this server knows of no instant the digest
			// was last changed at and claims none.
			annotations: RESOURCE_ANNOTATIONS,
			cacheHint: RESOURCE_CACHE_HINT,
		},
		observedResource(
			RECOVERY_LAST_WEEK_URI,
			async (uri: URL, ctx: ServerContext) => {
				const summary = await readRecoverySummary({
					signal: ctx.mcpReq.signal,
				});

				return {
					contents: [
						{
							uri: uri.href,
							mimeType: RESOURCE_MIME_TYPE,
							text: formatJson(summary),
						},
					],
				};
			},
		),
	);
}

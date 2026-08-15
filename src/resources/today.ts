import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { formatJson } from "@/json";
import { readTodaySnapshot } from "@/whoop/reads/today-snapshot";
import { observedResource } from "./observed";
import {
	RESOURCE_ANNOTATIONS,
	RESOURCE_CACHE_HINT,
	RESOURCE_MIME_TYPE,
} from "./policy";

const TODAY_URI = "whoop://today";

export function registerTodayResource(server: McpServer): void {
	server.registerResource(
		"whoop_today",
		TODAY_URI,
		{
			title: "WHOOP today",
			description:
				'Today on WHOOP, as a snapshot to attach to a conversation: the physiological cycle currently running with the strain accumulated in it so far, the recovery scored for that cycle, and the sleep that started it. The same answer the "get_today_snapshot" tool gives, for the user this server is logged in as. Read it again for fresher numbers — WHOOP scores today while it runs.',
			mimeType: RESOURCE_MIME_TYPE,
			// No `lastModified`: today is still being lived and WHOOP rescores it
			// while it runs, so this server knows of no instant it was last
			// modified at and claims none.
			annotations: RESOURCE_ANNOTATIONS,
			cacheHint: RESOURCE_CACHE_HINT,
		},
		observedResource(TODAY_URI, async (uri: URL, ctx: ServerContext) => {
			const snapshot = await readTodaySnapshot({ signal: ctx.mcpReq.signal });

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: RESOURCE_MIME_TYPE,
						text: formatJson(snapshot),
					},
				],
			};
		}),
	);
}

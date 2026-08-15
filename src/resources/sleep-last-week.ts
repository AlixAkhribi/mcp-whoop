import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { formatJson } from "@/json";
import { readSleepSummary } from "@/whoop/reads/sleep-summary";
import { observedResource } from "./observed";
import {
	RESOURCE_ANNOTATIONS,
	RESOURCE_CACHE_HINT,
	RESOURCE_MIME_TYPE,
} from "./policy";

const SLEEP_LAST_WEEK_URI = "whoop://sleep/last-week";

export function registerSleepLastWeekResource(server: McpServer): void {
	server.registerResource(
		"whoop_sleep_last_week",
		SLEEP_LAST_WEEK_URI,
		{
			title: "WHOOP sleep, last week",
			description:
				'The last seven nights of WHOOP sleep, as a digest to attach to a conversation: how many of those nights WHOOP holds and has scored, the mean, low and high of sleep performance, time in bed and sleep efficiency across them, the sleep stage totals beneath them, and one row per night, newest first. Naps are counted apart and never averaged into the nightly figures. The same answer the "get_sleep_summary" tool gives when it is asked for no particular range. Read it again for fresher numbers — the newest night may not be scored yet.',
			mimeType: RESOURCE_MIME_TYPE,
			// No `lastModified`: the week reaches to the night behind the cycle now
			// running, which WHOOP may still be scoring, so this server knows of no
			// instant the digest was last changed at and claims none.
			annotations: RESOURCE_ANNOTATIONS,
			cacheHint: RESOURCE_CACHE_HINT,
		},
		observedResource(
			SLEEP_LAST_WEEK_URI,
			async (uri: URL, ctx: ServerContext) => {
				const summary = await readSleepSummary({
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

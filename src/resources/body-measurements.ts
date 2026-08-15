import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { formatJson } from "@/json";
import { readBodyMeasurements } from "@/whoop/reads/body-measurements";
import { observedResource } from "./observed";
import {
	RESOURCE_ANNOTATIONS,
	RESOURCE_CACHE_HINT,
	RESOURCE_MIME_TYPE,
} from "./policy";

const BODY_MEASUREMENTS_URI = "whoop://body-measurements";

export function registerBodyMeasurementsResource(server: McpServer): void {
	server.registerResource(
		"whoop_body_measurements",
		BODY_MEASUREMENTS_URI,
		{
			title: "WHOOP body measurements",
			description:
				'The body WHOOP scores this user against, as a card to attach to a conversation: the height, the weight and the maximum heart rate held for the account this server is logged in as. The same answer the "get_body_measurements" tool gives. Attach it to have an assistant read strain, calories or heart rate against the body they belong to.',
			mimeType: RESOURCE_MIME_TYPE,
			// No `lastModified`: WHOOP's body measurements carry no instant they
			// were last changed at, and this server invents none.
			annotations: RESOURCE_ANNOTATIONS,
			cacheHint: RESOURCE_CACHE_HINT,
		},
		observedResource(
			BODY_MEASUREMENTS_URI,
			async (uri: URL, ctx: ServerContext) => {
				const measurements = await readBodyMeasurements({
					signal: ctx.mcpReq.signal,
				});

				return {
					contents: [
						{
							uri: uri.href,
							mimeType: RESOURCE_MIME_TYPE,
							text: formatJson(measurements),
						},
					],
				};
			},
		),
	);
}

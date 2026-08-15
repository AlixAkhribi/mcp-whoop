import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { formatJson } from "@/json";
import { readProfile } from "@/whoop/reads/profile";
import { observedResource } from "./observed";
import {
	RESOURCE_ANNOTATIONS,
	RESOURCE_CACHE_HINT,
	RESOURCE_MIME_TYPE,
} from "./policy";

const PROFILE_URI = "whoop://profile";

export function registerProfileResource(server: McpServer): void {
	server.registerResource(
		"whoop_profile",
		PROFILE_URI,
		{
			title: "WHOOP profile",
			description:
				'Who this server is logged in as on WHOOP, as a card to attach to a conversation: the account\'s name, email address and WHOOP user id. The same answer the "get_profile" tool gives. Attach it to have an assistant address the person by name, or to confirm which WHOOP account these answers are about.',
			mimeType: RESOURCE_MIME_TYPE,
			// No `lastModified`: WHOOP's basic profile carries no instant it was
			// last changed at, and this server invents none.
			annotations: RESOURCE_ANNOTATIONS,
			// Though the record itself is stable, a cached copy would keep
			// confirming the wrong identity after a re-login — the very question
			// this resource exists to answer.
			cacheHint: RESOURCE_CACHE_HINT,
		},
		observedResource(PROFILE_URI, async (uri: URL, ctx: ServerContext) => {
			const profile = await readProfile({ signal: ctx.mcpReq.signal });

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: RESOURCE_MIME_TYPE,
						text: formatJson(profile),
					},
				],
			};
		}),
	);
}

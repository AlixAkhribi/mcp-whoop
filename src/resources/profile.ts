import type {
	Annotations,
	McpServer,
	ServerContext,
} from "@modelcontextprotocol/server";

import { answerProfile } from "@/answers/profile";
import { observedResource } from "./observed";

/** Where the profile is addressed. */
const PROFILE_URI = "whoop://profile";

/**
 * What a read answers with, named once: the listing advertises it and the read
 * declares it, and a client that trusted the first would be misled by a second
 * that disagreed.
 */
const PROFILE_MIME_TYPE = "application/json";

/**
 * Who this resource is meant for: the person choosing it out of their client's
 * picker, and the model it is then handed to. Both, because a resource crosses
 * from one to the other — the user initiates the fetch and the assistant reads
 * what comes back.
 *
 * No `lastModified`: WHOOP's basic profile carries no instant it was last
 * changed at, and this server invents none. `priority` is absent because
 * nothing here ranks one curated resource above another.
 *
 * Checked against the SDK's own type rather than annotated with it, so a field
 * whose name is misspelled fails to compile here instead of travelling to
 * clients as something none of them reads.
 */
const PROFILE_ANNOTATIONS = {
	audience: ["user", "assistant"],
} satisfies Annotations;

/**
 * How long a client may reuse a read of the profile: not at all.
 *
 * Zero — "immediately stale" in the 2026-07-28 revision — though the record
 * itself is stable, because the answer is bound to whoever the stored login
 * belongs to, and `npx mcp-whoop login` can hand the store to a different
 * WHOOP account while the URI, the server and the client's authorization
 * context all look unchanged: everything a cache key is made of. A cached
 * copy of this resource would then keep confirming the wrong identity — the
 * very question it exists to answer — and this server could never call it
 * back: it declares `listChanged: false` and accepts no subscription.
 * Private, because it is the one answer here that identifies who the user is.
 */
const PROFILE_READ_TTL_MS = 0;

/**
 * Registers the `whoop://profile` resource on a server instance.
 *
 * Named, titled and described for a human scanning a list of things to attach
 * to a conversation: whose profile it is, in the words someone would use to ask
 * for it, rather than the endpoint it is read from.
 */
export function registerProfileResource(server: McpServer): void {
	server.registerResource(
		"whoop_profile",
		PROFILE_URI,
		{
			title: "WHOOP profile",
			description:
				'Who this server is logged in as on WHOOP, as a card to attach to a conversation: the account\'s name, email address and WHOOP user id. The same answer the "get_profile" tool gives. Attach it to have an assistant address the person by name, or to confirm which WHOOP account these answers are about.',
			mimeType: PROFILE_MIME_TYPE,
			annotations: PROFILE_ANNOTATIONS,
			cacheHint: { ttlMs: PROFILE_READ_TTL_MS, cacheScope: "private" },
		},
		observedResource(PROFILE_URI, async (uri: URL, ctx: ServerContext) => {
			// The request's own abort signal rides along, so a read the client
			// cancels stops asking WHOOP instead of running out its timeout.
			const { json } = await answerProfile(ctx.mcpReq.signal);

			// One item, echoing the URI it was read from: a profile is one record,
			// and the text is the tool's own text, unchanged.
			return {
				contents: [{ uri: uri.href, mimeType: PROFILE_MIME_TYPE, text: json }],
			};
		}),
	);
}

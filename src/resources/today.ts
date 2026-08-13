import type {
	Annotations,
	McpServer,
	ServerContext,
} from "@modelcontextprotocol/server";

import { answerToday } from "@/summaries/today";
import { observedResource } from "./observed";

/** Where the today snapshot is addressed. */
const TODAY_URI = "whoop://today";

/**
 * What a read answers with, named once: the listing advertises it and the read
 * declares it, and a client that trusted the first would be misled by a second
 * that disagreed.
 */
const TODAY_MIME_TYPE = "application/json";

/**
 * Who this resource is meant for: the person choosing it out of their client's
 * picker, and the model it is then handed to. Both, because a resource crosses
 * from one to the other — the user initiates the fetch and the assistant reads
 * what comes back.
 *
 * No `lastModified`: today is still being lived and WHOOP rescores it while it
 * runs, so this server knows of no instant it was last modified at and claims
 * none. `priority` is absent because nothing here ranks one curated resource
 * above another.
 *
 * Checked against the SDK's own type rather than annotated with it, so a field
 * whose name is misspelled fails to compile here instead of travelling to
 * clients as something none of them reads.
 */
const TODAY_ANNOTATIONS = {
	audience: ["user", "assistant"],
} satisfies Annotations;

/**
 * How long a client may reuse a read of today: not at all.
 *
 * Zero — "immediately stale" in the 2026-07-28 revision — because the answer is
 * bound to whoever the stored login belongs to, and `npx mcp-whoop login` can
 * hand the store to a different WHOOP account while the URI, the server and
 * the client's authorization context all look unchanged: everything a cache
 * key is made of. This server could never call such a copy back — it declares
 * `listChanged: false` and accepts no subscription — so no positive lifetime
 * is one it can stand behind. Private, because it is one person's day.
 */
const TODAY_READ_TTL_MS = 0;

/**
 * Registers the `whoop://today` resource on a server instance.
 *
 * Named, titled and described for a human scanning a list of things to attach
 * to a conversation: what it is, in the words someone would use to ask for it,
 * rather than the endpoint it is assembled from.
 */
export function registerTodayResource(server: McpServer): void {
	server.registerResource(
		"whoop_today",
		TODAY_URI,
		{
			title: "WHOOP today",
			description:
				'Today on WHOOP, as a snapshot to attach to a conversation: the physiological cycle currently running with the strain accumulated in it so far, the recovery scored for that cycle, and the sleep that started it. The same answer the "get_today_snapshot" tool gives, for the user this server is logged in as. Read it again for fresher numbers — WHOOP scores today while it runs.',
			mimeType: TODAY_MIME_TYPE,
			annotations: TODAY_ANNOTATIONS,
			cacheHint: { ttlMs: TODAY_READ_TTL_MS, cacheScope: "private" },
		},
		observedResource(TODAY_URI, async (uri: URL, ctx: ServerContext) => {
			// The request's own abort signal rides along, so a read the client
			// cancels stops asking WHOOP instead of running out its timeout.
			const { json } = await answerToday(ctx.mcpReq.signal);

			// One item, echoing the URI it was read from: today is a single
			// snapshot, and the text is the tool's own text, unchanged.
			return {
				contents: [{ uri: uri.href, mimeType: TODAY_MIME_TYPE, text: json }],
			};
		}),
	);
}

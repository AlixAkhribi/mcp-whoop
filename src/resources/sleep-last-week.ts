import type {
	Annotations,
	McpServer,
	ServerContext,
} from "@modelcontextprotocol/server";

import { answerSleepSummary } from "@/summaries/sleep";
import { observedResource } from "./observed";

/**
 * Where the sleep digest is addressed. The path says the range: a resource
 * takes no arguments, so the week it speaks for has to be in the URI a user
 * picks rather than in something they could have asked for and did not.
 */
const SLEEP_LAST_WEEK_URI = "whoop://sleep/last-week";

/**
 * What a read answers with, named once: the listing advertises it and the read
 * declares it, and a client that trusted the first would be misled by a second
 * that disagreed.
 */
const SLEEP_LAST_WEEK_MIME_TYPE = "application/json";

/**
 * Who this resource is meant for: the person choosing it out of their client's
 * picker, and the model it is then handed to. Both, because a resource crosses
 * from one to the other — the user initiates the fetch and the assistant reads
 * what comes back.
 *
 * No `lastModified`: the week reaches to the night behind the cycle now
 * running, which WHOOP may still be scoring, so this server knows of no instant
 * the digest was last changed at and claims none. `priority` is absent because
 * nothing here ranks one curated resource above another.
 *
 * Checked against the SDK's own type rather than annotated with it, so a field
 * whose name is misspelled fails to compile here instead of travelling to
 * clients as something none of them reads.
 */
const SLEEP_LAST_WEEK_ANNOTATIONS = {
	audience: ["user", "assistant"],
} satisfies Annotations;

/**
 * How long a client may reuse a read of the week: not at all.
 *
 * Zero — "immediately stale" in the 2026-07-28 revision — because the answer is
 * bound to whoever the stored login belongs to, and `npx mcp-whoop login` can
 * hand the store to a different WHOOP account while the URI, the server and
 * the client's authorization context all look unchanged: everything a cache
 * key is made of. This server could never call such a copy back — it declares
 * `listChanged: false` and accepts no subscription — so no positive lifetime
 * is one it can stand behind. Private, because it is one person's week.
 */
const SLEEP_LAST_WEEK_READ_TTL_MS = 0;

/**
 * Registers the `whoop://sleep/last-week` resource on a server instance.
 *
 * Named, titled and described for a human scanning a list of things to attach
 * to a conversation: which week it covers and what it says about it, in the
 * words someone would use to ask for it, rather than the endpoint it is
 * digested from.
 */
export function registerSleepLastWeekResource(server: McpServer): void {
	server.registerResource(
		"whoop_sleep_last_week",
		SLEEP_LAST_WEEK_URI,
		{
			title: "WHOOP sleep, last week",
			description:
				'The last seven nights of WHOOP sleep, as a digest to attach to a conversation: how many of those nights WHOOP holds and has scored, the mean, low and high of sleep performance, time in bed and sleep efficiency across them, the sleep stage totals beneath them, and one row per night, newest first. Naps are counted apart and never averaged into the nightly figures. The same answer the "get_sleep_summary" tool gives when it is asked for no particular range. Read it again for fresher numbers — the newest night may not be scored yet.',
			mimeType: SLEEP_LAST_WEEK_MIME_TYPE,
			annotations: SLEEP_LAST_WEEK_ANNOTATIONS,
			cacheHint: {
				ttlMs: SLEEP_LAST_WEEK_READ_TTL_MS,
				cacheScope: "private",
			},
		},
		observedResource(
			SLEEP_LAST_WEEK_URI,
			async (uri: URL, ctx: ServerContext) => {
				// Unasked: the range is the shared path's own default, so this read
				// and a no-argument tool call are one week digested one way. The
				// request's own abort signal rides along, so a read the client
				// cancels stops asking WHOOP instead of running out its timeout.
				const { json } = await answerSleepSummary(undefined, ctx.mcpReq.signal);

				// One item, echoing the URI it was read from: a week is one digest,
				// and the text is the tool's own text, unchanged.
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: SLEEP_LAST_WEEK_MIME_TYPE,
							text: json,
						},
					],
				};
			},
		),
	);
}

import type {
	Annotations,
	McpServer,
	ServerContext,
} from "@modelcontextprotocol/server";

import { answerBodyMeasurements } from "@/answers/body-measurements";
import { observedResource } from "./observed";

/** Where the body measurements are addressed. */
const BODY_MEASUREMENTS_URI = "whoop://body-measurements";

/**
 * What a read answers with, named once: the listing advertises it and the read
 * declares it, and a client that trusted the first would be misled by a second
 * that disagreed.
 */
const BODY_MEASUREMENTS_MIME_TYPE = "application/json";

/**
 * Who this resource is meant for: the person choosing it out of their client's
 * picker, and the model it is then handed to. Both, because a resource crosses
 * from one to the other — the user initiates the fetch and the assistant reads
 * what comes back.
 *
 * No `lastModified`: WHOOP's body measurements carry no instant they were last
 * changed at, and this server invents none. `priority` is absent because
 * nothing here ranks one curated resource above another.
 *
 * Checked against the SDK's own type rather than annotated with it, so a field
 * whose name is misspelled fails to compile here instead of travelling to
 * clients as something none of them reads.
 */
const BODY_MEASUREMENTS_ANNOTATIONS = {
	audience: ["user", "assistant"],
} satisfies Annotations;

/**
 * How long a client may reuse a read of the body measurements: not at all.
 *
 * Zero — "immediately stale" in the 2026-07-28 revision — though the record
 * itself is stable, because the answer is bound to whoever the stored login
 * belongs to, and `npx mcp-whoop login` can hand the store to a different
 * WHOOP account while the URI, the server and the client's authorization
 * context all look unchanged: everything a cache key is made of. This server
 * could never call such a copy back — it declares `listChanged: false` and
 * accepts no subscription — so no positive lifetime is one it can stand
 * behind. Private, because it is one person's body.
 */
const BODY_MEASUREMENTS_READ_TTL_MS = 0;

/**
 * Registers the `whoop://body-measurements` resource on a server instance.
 *
 * Named, titled and described for a human scanning a list of things to attach
 * to a conversation: whose measurements they are, in the words someone would
 * use to ask for them, rather than the endpoint they are read from.
 */
export function registerBodyMeasurementsResource(server: McpServer): void {
	server.registerResource(
		"whoop_body_measurements",
		BODY_MEASUREMENTS_URI,
		{
			title: "WHOOP body measurements",
			description:
				'The body WHOOP scores this user against, as a card to attach to a conversation: the height, the weight and the maximum heart rate held for the account this server is logged in as. The same answer the "get_body_measurements" tool gives. Attach it to have an assistant read strain, calories or heart rate against the body they belong to.',
			mimeType: BODY_MEASUREMENTS_MIME_TYPE,
			annotations: BODY_MEASUREMENTS_ANNOTATIONS,
			cacheHint: {
				ttlMs: BODY_MEASUREMENTS_READ_TTL_MS,
				cacheScope: "private",
			},
		},
		observedResource(
			BODY_MEASUREMENTS_URI,
			async (uri: URL, ctx: ServerContext) => {
				// The request's own abort signal rides along, so a read the client
				// cancels stops asking WHOOP instead of running out its timeout.
				const { json } = await answerBodyMeasurements(ctx.mcpReq.signal);

				// One item, echoing the URI it was read from: measurements are one
				// record, and the text is the tool's own text, unchanged.
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: BODY_MEASUREMENTS_MIME_TYPE,
							text: json,
						},
					],
				};
			},
		),
	);
}

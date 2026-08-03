import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { redactSecrets } from "@/lib/redaction";
import { createServer } from "@/server";

/**
 * Serves this package over stdio. stdout is exclusively the JSON-RPC wire, so
 * every diagnostic goes to stderr — a stray stdout write would corrupt the
 * client's view of the stream. Diagnostics are scrubbed first, since one
 * quoting an upstream failure verbatim could carry token material into the
 * host's logs.
 */
serveStdio(createServer, {
	onerror: (error) => {
		console.error(
			redactSecrets(
				error instanceof Error ? (error.stack ?? error.message) : String(error),
			),
		);
	},
});

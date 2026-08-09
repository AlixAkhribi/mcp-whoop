import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { log } from "@/lib/log";
import { createServer, manifest } from "@/server";

// Announced before serving so a host's log opens by naming what produced it,
// version and all — the first question support asks of a captured stderr.
log.info(`${manifest.name} ${manifest.version} serving MCP over stdio`);

/**
 * Serves this package over stdio. stdout is exclusively the JSON-RPC wire, so
 * every diagnostic goes through the stderr logger — a stray stdout write would
 * corrupt the client's view of the stream, and the logger scrubs each line, so
 * an error quoting an upstream failure cannot carry token material into the
 * host's logs.
 */
serveStdio(createServer, {
	onerror: (error) => {
		log.error(
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
	},
});

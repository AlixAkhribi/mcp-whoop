import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createServer } from "../server/index.js";

/**
 * Serves this package over stdio. stdout is exclusively the JSON-RPC wire, so
 * every diagnostic goes to stderr — a stray stdout write would corrupt the
 * client's view of the stream.
 */
serveStdio(createServer, {
	onerror: (error) => {
		console.error(error);
	},
});

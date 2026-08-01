import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { registerTools } from "../tools/index.js";

const manifestSchema = z.object({
	name: z.string(),
	version: z.string(),
});

/**
 * The published identity of this package. Per ADR 0001 the manifest `name` is
 * the one place that identity lives, and the manifest `version` is a
 * release-time placeholder, so both are read from `package.json` rather than
 * duplicated here.
 */
const manifest = manifestSchema.parse(
	JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	),
);

/**
 * Builds a fresh {@link McpServer} carrying this package's name and version,
 * with every tool registered.
 *
 * Every serving unit (connection or request) gets its own instance — never a
 * shared singleton.
 */
export function createServer(): McpServer {
	const server = new McpServer({
		name: manifest.name,
		version: manifest.version,
	});
	registerTools(server);

	return server;
}

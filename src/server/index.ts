import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { grantedScopes } from "@/auth/tokens/granted-scopes";
import { registerTools } from "@/tools";

/** The manifest fields this server reports as its MCP identity. */
const manifestSchema = z.object({
	name: z.string(),
	version: z.string(),
});

/**
 * The nearest `package.json` above this module. How many directories up that
 * is depends on how the code is running — a `dist/` chunk laid out by the
 * bundler, or `src/` under tsx and vitest — so a walk, not a fixed number of
 * `../` hops, is what finds the same manifest in every layout.
 */
function manifestPath(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error("no package.json above this module");
		dir = parent;
	}
}

/**
 * The published identity this server reports over MCP, read from the manifest
 * rather than duplicated here: the package name differs from the repository
 * name, and the version is rewritten at release time, so `package.json` is the
 * only place either can be correct.
 */
const manifest = manifestSchema.parse(
	JSON.parse(readFileSync(manifestPath(), "utf8")),
);

/**
 * Builds a fresh {@link McpServer} carrying this package's name and version,
 * registering the tools the stored login's granted scopes allow.
 *
 * Every serving unit (connection or request) gets its own instance, never a
 * shared singleton.
 */
export async function createServer(): Promise<McpServer> {
	const server = new McpServer({
		name: manifest.name,
		version: manifest.version,
	});
	registerTools(server, await grantedScopes());

	return server;
}

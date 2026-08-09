import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { grantedScopes } from "@/auth/tokens/granted-scopes";
import { log } from "@/lib/log";
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
 * only place either can be correct. Exported so the stdio entry can announce
 * on stderr what exactly is serving.
 */
export const manifest = manifestSchema.parse(
	JSON.parse(readFileSync(manifestPath(), "utf8")),
);

/**
 * How long a client may reuse a `tools/list` answer: one hour.
 *
 * The surface only changes when the stored login does — a new grant, or none —
 * and every connection rebuilds the server from the store, so a client that
 * re-lists after reconnecting sees the change regardless of this hint. An hour
 * is the ceiling on how stale a *held* connection's copy can be.
 */
const TOOLS_LIST_TTL_MS = 3_600_000;

/**
 * Builds a fresh {@link McpServer} carrying this package's name and version,
 * registering the tools the stored login's granted scopes allow.
 *
 * Every serving unit (connection or request) gets its own instance, never a
 * shared singleton.
 *
 * The `tools/list` answer is cacheable but never shareable: which tools exist
 * is a function of the scopes one login was granted, so it is scoped `private`
 * — the value the 2026-07-28 revision requires beside the lifetime.
 */
export async function createServer(): Promise<McpServer> {
	const server = new McpServer(
		{
			name: manifest.name,
			version: manifest.version,
		},
		{
			cacheHints: {
				"tools/list": { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" },
			},
		},
	);
	const scopes = await grantedScopes();
	// The one line that answers "why is a tool missing": the surface is a
	// function of the stored grant, and nothing else says which grant this
	// serving unit read.
	log.debug(
		scopes
			? `serving the tools these granted scopes allow: ${scopes.join(", ")}`
			: "serving every tool: no stored login records a grant to narrow by",
	);
	registerTools(server, scopes);

	return server;
}

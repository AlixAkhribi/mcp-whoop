import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { grantedScopes } from "@/auth/tokens/granted-scopes";
import { log } from "@/lib/log";
import { registerResources } from "@/resources";
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
 * How long a client may reuse a listing of what this server serves: one hour,
 * for the tools and the resources alike.
 *
 * The resource listing is the same five entries for every login — the grant
 * gates reads, not listings — so any lifetime is honest there. The tool
 * listing follows the grant read when the serving process starts, and its
 * registrations hold still for that process's life; a cached copy can
 * therefore never show a client anything the process itself would not answer,
 * so the hint spares re-lists without hiding any change a re-list could see.
 * What a *held* process cannot do is track a grant rewritten underneath it —
 * for the tools that takes the restart every reconnecting client performs.
 */
const LIST_TTL_MS = 3_600_000;

/**
 * Builds a fresh {@link McpServer} carrying this package's name and version,
 * registering every resource and the tools the stored login's granted scopes
 * allow. One grant still rules both surfaces — it just acts at different
 * moments: it narrows which tools are registered here, and it is re-read to
 * judge every resource read (and tool call) inside the shared answer paths,
 * because the 2026-07-28 revision forbids `resources/list` varying with
 * connection state and a startup snapshot of the grant is exactly that.
 *
 * Every serving unit (connection or request) gets its own instance, never a
 * shared singleton.
 *
 * Both listings are cacheable but never shareable, so they are scoped
 * `private` — the value the 2026-07-28 revision requires beside the lifetime.
 * (The resource listing is the same five entries for every login and could
 * call itself `public`; `private` claims less, costs a stdio client nothing,
 * and keeps the two listings on one policy.)
 *
 * The resources capability is declared here rather than left to the first
 * registration to imply, because that is the only way to keep `listChanged`
 * off: the SDK fills it in as `true` when a resource is registered against an
 * undeclared capability. This server promises neither — it pushes no updates
 * and its resource set never changes — and `false` is what the specification
 * says an absent field means anyway. `subscribe` stays absent for the same
 * reason it is never set: a resource here is a snapshot the client re-reads,
 * not a stream it follows.
 */
export async function createServer(): Promise<McpServer> {
	const server = new McpServer(
		{
			name: manifest.name,
			version: manifest.version,
		},
		{
			capabilities: { resources: { listChanged: false } },
			cacheHints: {
				"tools/list": { ttlMs: LIST_TTL_MS, cacheScope: "private" },
				"resources/list": { ttlMs: LIST_TTL_MS, cacheScope: "private" },
			},
		},
	);
	const scopes = await grantedScopes();
	// The one line that answers "why is a tool missing": the tool surface is a
	// function of the stored grant, and nothing else says which grant this
	// serving unit read. The resources are always all five — a read a grant
	// does not permit says so itself, naming the scopes it is missing.
	log.debug(
		scopes
			? `serving every resource and the tools these granted scopes allow: ${scopes.join(", ")}`
			: "serving every tool and resource: no stored login records a grant to narrow by",
	);
	registerTools(server, scopes);
	registerResources(server);

	return server;
}

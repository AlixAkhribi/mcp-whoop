import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-annotations-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** Every read scope WHOOP defines — what a default login is granted. */
const ALL_READ_SCOPES = [
	"read:profile",
	"read:body_measurement",
	"read:cycles",
	"read:sleep",
	"read:recovery",
	"read:workout",
];

/** Seeds a store with a live login that was granted the given scopes. */
async function seedStore(store: string, scopes: string[]): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes,
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store. Nothing here calls a tool, so no stand-in WHOOP is needed: what a tool
 * says about itself is decided at registration.
 *
 * The revision is pinned so the assertions read the wire of the specification
 * they are written against, rather than whatever era a negotiation lands on.
 */
async function withClient<T>(
	store: string,
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client(
		{ name: "tool-annotations-stdio-test", version: "0.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: { WHOOP_TOKEN_STORE: store },
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

describe("the behavior tools/list declares for each tool, over real stdio", () => {
	it("marks every tool a read-only call on a world beyond this server", async () => {
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const { tools } = await withClient(store, (client) => client.listTools());

		// The whole surface, so no registration can quietly go unannotated.
		expect(tools).toHaveLength(14);
		for (const tool of tools) {
			// Deep equality rather than a subset: a hint the specification only
			// gives meaning to on tools that write has no business on any of these,
			// and a client reading one here would be reading it wrong.
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				openWorldHint: true,
			});
		}
	}, 30_000);
});

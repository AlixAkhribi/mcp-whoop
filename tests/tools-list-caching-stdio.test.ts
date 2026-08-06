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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-tools-list-"));
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
 * store. Nothing here calls a tool, so no stand-in WHOOP is needed: the tool
 * surface is decided from the store alone.
 *
 * The revision is pinned rather than probed: cache hints on a result are a
 * 2026-07-28 contract, so the connection that asserts them has to be the one
 * that revision describes, and a pin fails loudly instead of quietly falling
 * back to an era where the fields do not exist at all.
 */
async function withClient<T>(
	store: string,
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client(
		{ name: "tools-list-caching-stdio-test", version: "0.0.0" },
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

/**
 * The order this server advertises its tools in, pinned. Identity first, then
 * the mapping tools domain by domain in WHOOP's own order — cycles, sleep,
 * recovery, workouts, each listing before the reads that narrow it — then the
 * summaries, and the whole-day snapshot last.
 *
 * The order is part of the answer, not an accident of how the registrations
 * happen to be written: a client that caches this list for an hour and a model
 * that reads it should see the same surface on every connection and after
 * every restart.
 */
const CANONICAL_TOOL_ORDER = [
	"get_profile",
	"get_body_measurements",
	"list_cycles",
	"get_cycle",
	"list_sleeps",
	"get_sleep",
	"get_cycle_sleep",
	"list_recoveries",
	"get_cycle_recovery",
	"list_workouts",
	"get_workout",
	"get_sleep_summary",
	"get_recovery_summary",
	"get_today_snapshot",
];

describe("the tools/list answer's caching hints and order, over real stdio", () => {
	it("carries a one-hour private cache hint on the result itself", async () => {
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(store, (client) => client.listTools());

		expect(result.ttlMs).toBe(3_600_000);
		expect(result.cacheScope).toBe("private");
	}, 30_000);

	it("lists the full surface in the canonical order from every fresh process", async () => {
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const names = async (): Promise<string[]> =>
			withClient(store, async (client) =>
				(await client.listTools()).tools.map((tool) => tool.name),
			);
		const first = await names();
		const second = await names();

		expect(first).toEqual(CANONICAL_TOOL_ORDER);
		expect(second).toEqual(CANONICAL_TOOL_ORDER);
	}, 30_000);

	it("keeps the canonical relative order when a grant narrows the surface", async () => {
		const store = await temporaryStore();
		await seedStore(store, [
			"read:cycles",
			"read:sleep",
			"read:recovery",
			"offline",
		]);

		const names = await withClient(store, async (client) =>
			(await client.listTools()).tools.map((tool) => tool.name),
		);

		// Nothing needing the profile, body-measurement or workout grants, and
		// what is left reads in the same order it does under the full grant.
		expect(names).toEqual([
			"list_cycles",
			"get_cycle",
			"list_sleeps",
			"get_sleep",
			"get_cycle_sleep",
			"list_recoveries",
			"get_cycle_recovery",
			"get_sleep_summary",
			"get_recovery_summary",
			"get_today_snapshot",
		]);
	}, 30_000);
});

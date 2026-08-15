import { describe, expect, it } from "vitest";

import {
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

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
		await seedStore(store);

		const result = await withBuiltStdioClient({ store }, (client) =>
			client.listTools(),
		);

		expect(result.ttlMs).toBe(3_600_000);
		expect(result.cacheScope).toBe("private");
	});

	it("lists the full surface in the canonical order from every fresh process", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const names = async (): Promise<string[]> =>
			withBuiltStdioClient({ store }, async (client) =>
				(await client.listTools()).tools.map((tool) => tool.name),
			);
		const first = await names();
		const second = await names();

		expect(first).toEqual(CANONICAL_TOOL_ORDER);
		expect(second).toEqual(CANONICAL_TOOL_ORDER);
	});

	it("keeps the canonical relative order when a grant narrows the surface", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:cycles", "read:sleep", "read:recovery"]);

		const names = await withBuiltStdioClient({ store }, async (client) =>
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
	});
});

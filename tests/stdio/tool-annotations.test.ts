import { describe, expect, it } from "vitest";

import {
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store. Nothing here calls a tool, so no stand-in WHOOP is needed: what a tool
 * says about itself is decided at registration.
 *
 * The revision is pinned so the assertions read the wire of the specification
 * they are written against, rather than whatever era a negotiation lands on.
 */

describe("the behavior tools/list declares for each tool, over real stdio", () => {
	it("marks every tool a read-only call on a world beyond this server", async () => {
		const store = await temporaryStore();
		await seedStore(store);

		const { tools } = await withBuiltStdioClient({ store }, (client) =>
			client.listTools(),
		);

		for (const tool of tools) {
			// Deep equality rather than a subset: a hint the specification only
			// gives meaning to on tools that write has no business on any of these,
			// and a client reading one here would be reading it wrong.
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				openWorldHint: true,
			});
		}
	});
});

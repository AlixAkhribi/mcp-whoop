import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * The `hello` tool's input. A plain `z.object(...)` — no top-level
 * refine/transform and no date types — so it converts cleanly to the JSON
 * Schema that clients see in `tools/list`.
 */
const helloInputSchema = z.object({
	name: z.string().describe("Who to greet"),
});

/** Registers the `hello` tool on a server instance. */
export function registerHelloTool(server: McpServer): void {
	server.registerTool(
		"hello",
		{
			description: "Greets someone by name.",
			inputSchema: helloInputSchema,
		},
		({ name }) => ({ content: [{ type: "text", text: `Hello, ${name}!` }] }),
	);
}

import type { McpServer } from "@modelcontextprotocol/server";

import { registerHelloTool } from "./hello.js";

/** Registers every tool this package serves. One line per tool module. */
export function registerTools(server: McpServer): void {
	registerHelloTool(server);
}

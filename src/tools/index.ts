import type { McpServer } from "@modelcontextprotocol/server";

import { registerGetBodyMeasurementsTool } from "./get-body-measurements";
import { registerGetProfileTool } from "./get-profile";

/**
 * Registers the tools this package serves, one per tool module.
 *
 * `grantedScopes` is authoritative for the surface: a tool whose scope was not
 * granted is not registered, so a connected model never sees a tool WHOOP would
 * deny. `undefined` means no recorded grant to narrow by.
 */
export function registerTools(
	server: McpServer,
	grantedScopes?: readonly string[],
): void {
	if (grantedScopes === undefined || grantedScopes.includes("read:profile")) {
		registerGetProfileTool(server);
	}
	if (
		grantedScopes === undefined ||
		grantedScopes.includes("read:body_measurement")
	) {
		registerGetBodyMeasurementsTool(server);
	}
}

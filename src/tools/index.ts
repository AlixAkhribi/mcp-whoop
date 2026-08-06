import type { McpServer } from "@modelcontextprotocol/server";

import { registerGetBodyMeasurementsTool } from "./get-body-measurements";
import { registerGetCycleTool } from "./get-cycle";
import { registerGetCycleRecoveryTool } from "./get-cycle-recovery";
import { registerGetCycleSleepTool } from "./get-cycle-sleep";
import { registerGetProfileTool } from "./get-profile";
import { registerGetRecoverySummaryTool } from "./get-recovery-summary";
import { registerGetSleepTool } from "./get-sleep";
import { registerGetSleepSummaryTool } from "./get-sleep-summary";
import { registerGetTodaySnapshotTool } from "./get-today-snapshot";
import { registerGetWorkoutTool } from "./get-workout";
import { registerListCyclesTool } from "./list-cycles";
import { registerListRecoveriesTool } from "./list-recoveries";
import { registerListSleepsTool } from "./list-sleeps";
import { registerListWorkoutsTool } from "./list-workouts";

/**
 * Registers the tools this package serves, one per tool module.
 *
 * `grantedScopes` is authoritative for the surface: a tool whose scope was not
 * granted is not registered, so a connected model never sees a tool WHOOP would
 * deny. `undefined` means no recorded grant to narrow by.
 *
 * The order these calls appear in is the order `tools/list` advertises, so it
 * is canonical rather than incidental: identity first, then the mapping tools
 * domain by domain in WHOOP's own order — cycles, sleep, recovery, workouts,
 * each listing before the reads that narrow it — then the summaries, and the
 * whole-day snapshot last. Since narrowing only ever drops registrations, the
 * tools a partial grant leaves standing keep that same relative order.
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
	if (grantedScopes === undefined || grantedScopes.includes("read:cycles")) {
		registerListCyclesTool(server);
		registerGetCycleTool(server);
	}
	if (grantedScopes === undefined || grantedScopes.includes("read:sleep")) {
		registerListSleepsTool(server);
		registerGetSleepTool(server);
		// WHOOP declares no scope for GET /v2/cycle/{cycleId}/sleep — `security`
		// is absent where every sibling user-data read names one (OpenAPI,
		// 2026-08-04). It answers with a Sleep, so read:sleep is the gate it
		// would have named.
		registerGetCycleSleepTool(server);
	}
	if (grantedScopes === undefined || grantedScopes.includes("read:recovery")) {
		registerListRecoveriesTool(server);
		registerGetCycleRecoveryTool(server);
	}
	if (grantedScopes === undefined || grantedScopes.includes("read:workout")) {
		registerListWorkoutsTool(server);
		registerGetWorkoutTool(server);
	}
	// Reads sleep like the mapping tools above, but is advertised here: the
	// summaries stand together at the end of the canonical order, whichever
	// grant each of them needs.
	if (grantedScopes === undefined || grantedScopes.includes("read:sleep")) {
		registerGetSleepSummaryTool(server);
	}
	// A summary reading two listings needs both grants: half of them would only
	// buy a tool that fails on the read it was not allowed to make.
	if (
		grantedScopes === undefined ||
		(grantedScopes.includes("read:cycles") &&
			grantedScopes.includes("read:recovery"))
	) {
		registerGetRecoverySummaryTool(server);
	}
	// Today is a cycle, its recovery and its sleep at once: all three grants, or
	// the snapshot could only answer part of the question it advertises.
	if (
		grantedScopes === undefined ||
		(grantedScopes.includes("read:cycles") &&
			grantedScopes.includes("read:recovery") &&
			grantedScopes.includes("read:sleep"))
	) {
		registerGetTodaySnapshotTool(server);
	}
}

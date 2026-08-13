import type { McpServer } from "@modelcontextprotocol/server";

import { BODY_MEASUREMENT_SCOPES } from "@/answers/body-measurements";
import { PROFILE_SCOPES } from "@/answers/profile";
import { grantAllows } from "@/auth/tokens/granted-scopes";
import { RECOVERY_SUMMARY_SCOPES } from "@/summaries/recovery";
import { SLEEP_SUMMARY_SCOPES } from "@/summaries/sleep";
import { TODAY_SNAPSHOT_SCOPES } from "@/summaries/today";
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
	// The same scope a read of the `whoop://profile` resource demands when it
	// runs — one scope list, two surfaces, two moments it is checked at.
	if (grantAllows(grantedScopes, ...PROFILE_SCOPES)) {
		registerGetProfileTool(server);
	}
	// The same scope a read of the `whoop://body-measurements` resource demands
	// when it runs.
	if (grantAllows(grantedScopes, ...BODY_MEASUREMENT_SCOPES)) {
		registerGetBodyMeasurementsTool(server);
	}
	if (grantAllows(grantedScopes, "read:cycles")) {
		registerListCyclesTool(server);
		registerGetCycleTool(server);
	}
	if (grantAllows(grantedScopes, "read:sleep")) {
		registerListSleepsTool(server);
		registerGetSleepTool(server);
		// WHOOP declares no scope for GET /v2/cycle/{cycleId}/sleep — `security`
		// is absent where every sibling user-data read names one (OpenAPI,
		// 2026-08-04). It answers with a Sleep, so read:sleep is the gate it
		// would have named.
		registerGetCycleSleepTool(server);
	}
	if (grantAllows(grantedScopes, "read:recovery")) {
		registerListRecoveriesTool(server);
		registerGetCycleRecoveryTool(server);
	}
	if (grantAllows(grantedScopes, "read:workout")) {
		registerListWorkoutsTool(server);
		registerGetWorkoutTool(server);
	}
	// Reads sleep like the mapping tools above, but is advertised here: the
	// summaries stand together at the end of the canonical order, whichever
	// grant each of them needs. The same scope a read of the
	// `whoop://sleep/last-week` resource demands when it runs.
	if (grantAllows(grantedScopes, ...SLEEP_SUMMARY_SCOPES)) {
		registerGetSleepSummaryTool(server);
	}
	// A summary reading two listings needs both grants: half of them would only
	// buy a tool that fails on the read it was not allowed to make. The same
	// two a read of the `whoop://recovery/last-week` resource demands when it
	// runs.
	if (grantAllows(grantedScopes, ...RECOVERY_SUMMARY_SCOPES)) {
		registerGetRecoverySummaryTool(server);
	}
	// Today is a cycle, its recovery and its sleep at once — the same three a
	// read of the `whoop://today` resource demands when it runs.
	if (grantAllows(grantedScopes, ...TODAY_SNAPSHOT_SCOPES)) {
		registerGetTodaySnapshotTool(server);
	}
}

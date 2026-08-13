import type { McpServer } from "@modelcontextprotocol/server";

import { registerBodyMeasurementsResource } from "./body-measurements";
import { registerProfileResource } from "./profile";
import { registerRecoveryLastWeekResource } from "./recovery-last-week";
import { registerSleepLastWeekResource } from "./sleep-last-week";
import { registerTodayResource } from "./today";

/**
 * Registers the resources this package serves, one per resource module.
 *
 * The set is curated rather than exhaustive: a resource is what a user picks
 * out of their client's attachment list, so each one has to earn its place by
 * answering a question a person would ask — never by mirroring an endpoint.
 * The order these calls run in is the order a user's picker shows them, so it
 * is canonical rather than incidental: the day first, the person it belongs to
 * next, and the two weeks that explain the day last, widest span at the end.
 *
 * All five are registered unconditionally: the 2026-07-28 revision requires
 * `resources/list` to answer with what is currently available and forbids it
 * varying with connection state, and the stored grant is exactly that — it can
 * be rewritten by a re-login while a connection is held, which registrations
 * taken from a startup snapshot would never track. So the listing is the same
 * five for every login, and the grant gates each *read* instead, inside the
 * shared answer paths, against the store as it stands at that moment: a read
 * the current grant does not permit refuses by naming the missing scopes and
 * the login command — the same way every read already refuses when nothing is
 * logged in at all.
 */
export function registerResources(server: McpServer): void {
	registerTodayResource(server);
	registerProfileResource(server);
	registerBodyMeasurementsResource(server);
	registerRecoveryLastWeekResource(server);
	registerSleepLastWeekResource(server);
}

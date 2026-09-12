import type { McpServer } from "@modelcontextprotocol/server";

import { registerBodyMeasurementsResource } from "./body-measurements";
import { registerDayResource } from "./day";
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
 * The day *template* registers beside today rather than in that order, because
 * it is not in that listing at all: a family is advertised as a pattern under
 * `resources/templates/list`, never enumerated into the set a user picks whole.
 * It sits next to today because it answers the same snapshot — today's is the
 * open cycle, and any other day is that snapshot addressed by its date.
 *
 * All are registered unconditionally: the 2026-07-28 revision requires
 * `resources/list` to answer with what is currently available and forbids it
 * varying with connection state, and the stored grant is exactly that — it can
 * be rewritten by a re-login while a connection is held, which registrations
 * taken from a startup snapshot would never track. So the listing is the same
 * set for every login, and the grant gates each *read* instead, inside the
 * shared answer paths, against the store as it stands at that moment: a read
 * the current grant does not permit refuses by naming the missing scopes and
 * the login command — the same way every read already refuses when nothing is
 * logged in at all.
 *
 * `resources/templates/list` stands under the same rule for the same reason:
 * the family is advertised whatever the grant, and whatever the grant a member
 * of it is judged by the store at the moment it is read.
 */
export function registerResources(server: McpServer): void {
	registerTodayResource(server);
	registerDayResource(server);
	registerProfileResource(server);
	registerBodyMeasurementsResource(server);
	registerRecoveryLastWeekResource(server);
	registerSleepLastWeekResource(server);
}

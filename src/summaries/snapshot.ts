import { z } from "zod";

import { cycleSchema, type WhoopCycle } from "@/api/data/cycles";
import { recoverySchema, type WhoopRecovery } from "@/api/data/recoveries";
import { sleepSchema, type WhoopSleep } from "@/api/data/sleeps";

/**
 * The fixed shape today's snapshot answers in: the cycle now running, the state
 * of the recovery scored for it, and the two records themselves — WHOOP's own,
 * verbatim, so a model reading them can rely on WHOOP's public documentation.
 */
export const todaySnapshotSchema = z.object({
	cycle: cycleSchema,
	// WHOOP's own state for today's recovery, or ABSENT for a cycle it holds no
	// recovery for at all.
	recovery_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
	recovery: recoverySchema.nullable(),
	sleep: sleepSchema.nullable(),
});

export type TodaySnapshot = z.infer<typeof todaySnapshotSchema>;

/**
 * Assembles today into one answer: the open cycle, the recovery WHOOP joined to
 * it, and the sleep that started it.
 *
 * A recovery WHOOP has not scored yet — pending, unscorable, or not held at all
 * — is reported as the state it is in, and a sleep WHOOP has no record of as
 * nothing, never as a failure: what is missing this morning is part of the
 * answer to "how am I today".
 */
export function snapshotOfToday(
	cycle: WhoopCycle,
	recovery: WhoopRecovery | null,
	sleep: WhoopSleep | null,
): TodaySnapshot {
	return {
		cycle,
		// A cycle WHOOP holds no recovery for at all is said as ABSENT: not
		// WHOOP's own word, because WHOOP has no record to say a word about, and
		// not silence either.
		recovery_state: recovery?.score_state ?? ("ABSENT" as const),
		recovery,
		sleep,
	};
}

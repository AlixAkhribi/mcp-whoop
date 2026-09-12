import { z } from "zod";

import { cycleSchema, type WhoopCycle } from "@/whoop/api/data/cycles";
import {
	recoverySchema,
	type WhoopRecovery,
} from "@/whoop/api/data/recoveries";
import { sleepSchema, type WhoopSleep } from "@/whoop/api/data/sleeps";

/**
 * The fixed-shape answer for one day: the cycle it was, the recovery WHOOP
 * scored for it together with that recovery's state, and the sleep that opened
 * it. A recovery not yet scored, or a sleep WHOOP has no record of, is reported
 * as a state of the day rather than as an error — the day exists even when its
 * score does not.
 *
 * One shape for every day, today's included: "today" is this snapshot of the
 * current open cycle, and any other day is the same snapshot addressed by its
 * date — so the tool and the two resources answering it cannot drift apart.
 */
export const daySnapshotSchema = z.object({
	cycle: cycleSchema,
	recovery_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
	recovery: recoverySchema.nullable(),
	sleep: sleepSchema.nullable(),
});

export type DaySnapshot = z.infer<typeof daySnapshotSchema>;

/** Builds the fixed-shape view shared by every surface that answers a day. */
export function buildDaySnapshot(
	cycle: WhoopCycle,
	recovery: WhoopRecovery | null,
	sleep: WhoopSleep | null,
): DaySnapshot {
	return {
		cycle,
		recovery_state: recovery?.score_state ?? ("ABSENT" as const),
		recovery,
		sleep,
	};
}

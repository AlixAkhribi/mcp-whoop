import { z } from "zod";

import type { WhoopCycle } from "@/api/data/cycles";
import type { WhoopRecovery } from "@/api/data/recoveries";
import { dayOf } from "./day";
import { type Spread, spreadOf, spreadSchema, toHundredths } from "./spread";

/**
 * The fixed shape a recovery summary answers in: the counts that say how much
 * of the asked-for window WHOOP actually holds, the spread of each recovery
 * metric over the scored days, and one row per cycle-day. No trend verdict —
 * the per-day rows carry the signal.
 */
export const recoverySummarySchema = z.object({
	days_requested: z.int(),
	days_with_records: z.int(),
	days_scored: z.int(),
	recovery_score: spreadSchema,
	hrv_rmssd_milli: spreadSchema,
	resting_heart_rate: spreadSchema,
	per_day: z.array(
		z.object({
			day: z.string(),
			// WHOOP's own state for the day's recovery, or ABSENT for a cycle it
			// holds no recovery for at all.
			score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
			recovery_score: z.number().nullable(),
			hrv_rmssd_milli: z.number().nullable(),
			resting_heart_rate: z.number().nullable(),
		}),
	),
});

export type RecoverySummary = z.infer<typeof recoverySummarySchema>;

/** A recovery WHOOP has finished scoring, as its score reads. */
type RecoveryScore = NonNullable<WhoopRecovery["score"]>;

/**
 * Digests WHOOP cycles and recoveries into the summary of the most recent
 * `daysRequested` cycle-days.
 *
 * The cycles are the days — taken in the order WHOOP lists them, newest first —
 * and each day's recovery is the one WHOOP keyed to that cycle's id: a recovery
 * carries no start of its own, so the join is what gives it a day. A cycle whose
 * recovery is pending, unscorable or missing still gets its row, carrying its
 * state and nulls, and counts as a day with a record only when a record exists.
 */
export function summarizeRecoveries(
	cycles: readonly WhoopCycle[],
	recoveries: readonly WhoopRecovery[],
	daysRequested: number,
): RecoverySummary {
	const days = cycles.slice(0, daysRequested);
	const byCycle = new Map(
		recoveries.map((recovery) => [recovery.cycle_id, recovery]),
	);

	const held = days
		.map((cycle) => byCycle.get(cycle.id))
		.filter((recovery) => !!recovery);
	const scored = held
		.map((recovery) => recovery.score)
		.filter((score) => !!score);
	/** One reading's spread over the scored days, and only over those. */
	const spreadOfReading = (read: (score: RecoveryScore) => number): Spread =>
		spreadOf(scored.map(read), toHundredths);

	return {
		days_requested: daysRequested,
		days_with_records: held.length,
		days_scored: scored.length,
		recovery_score: spreadOfReading((score) => score.recovery_score),
		hrv_rmssd_milli: spreadOfReading((score) => score.hrv_rmssd_milli),
		resting_heart_rate: spreadOfReading((score) => score.resting_heart_rate),
		per_day: days.map((cycle) => {
			const recovery = byCycle.get(cycle.id);

			return {
				day: dayOf(cycle),
				// A cycle WHOOP holds no recovery for at all is said as ABSENT: not
				// WHOOP's own word, because WHOOP has no record to say a word about,
				// and not silence either.
				score_state: recovery?.score_state ?? ("ABSENT" as const),
				recovery_score: recovery?.score?.recovery_score ?? null,
				hrv_rmssd_milli: recovery?.score?.hrv_rmssd_milli ?? null,
				resting_heart_rate: recovery?.score?.resting_heart_rate ?? null,
			};
		}),
	};
}

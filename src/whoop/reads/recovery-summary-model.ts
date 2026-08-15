import { z } from "zod";

import type { WhoopCycle } from "@/whoop/api/data/cycles";
import type { WhoopRecovery } from "@/whoop/api/data/recoveries";
import { getLocalDate } from "./day";
import {
	calculateSpread,
	roundToHundredths,
	type Spread,
	spreadSchema,
} from "./spread";

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
			score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
			recovery_score: z.number().nullable(),
			hrv_rmssd_milli: z.number().nullable(),
			resting_heart_rate: z.number().nullable(),
		}),
	),
});

export type RecoverySummary = z.infer<typeof recoverySummarySchema>;
type RecoveryScore = NonNullable<WhoopRecovery["score"]>;

/** Builds a recovery digest from already-fetched WHOOP records. */
export function buildRecoverySummary(
	cycles: readonly WhoopCycle[],
	recoveries: readonly WhoopRecovery[],
	daysRequested: number,
): RecoverySummary {
	const days = cycles.slice(0, daysRequested);
	const recoveriesByCycle = new Map(
		recoveries.map((recovery) => [recovery.cycle_id, recovery]),
	);
	const matchedRecoveries = days
		.map((cycle) => recoveriesByCycle.get(cycle.id))
		.filter((recovery) => recovery !== undefined);
	const scored = matchedRecoveries
		.map((recovery) => recovery.score)
		.filter((score) => score !== null && score !== undefined);
	const spreadFor = (read: (score: RecoveryScore) => number): Spread =>
		calculateSpread(scored.map(read), roundToHundredths);

	return {
		days_requested: daysRequested,
		days_with_records: matchedRecoveries.length,
		days_scored: scored.length,
		recovery_score: spreadFor((score) => score.recovery_score),
		hrv_rmssd_milli: spreadFor((score) => score.hrv_rmssd_milli),
		resting_heart_rate: spreadFor((score) => score.resting_heart_rate),
		per_day: days.map((cycle) => {
			const recovery = recoveriesByCycle.get(cycle.id);

			return {
				day: getLocalDate(cycle),
				score_state: recovery?.score_state ?? ("ABSENT" as const),
				recovery_score: recovery?.score?.recovery_score ?? null,
				hrv_rmssd_milli: recovery?.score?.hrv_rmssd_milli ?? null,
				resting_heart_rate: recovery?.score?.resting_heart_rate ?? null,
			};
		}),
	};
}

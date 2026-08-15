import { z } from "zod";

import type { WhoopSleep } from "@/whoop/api/data/sleeps";
import { getLocalDate } from "./day";
import { calculateSpread, roundToHundredths, spreadSchema } from "./spread";

export const sleepSummarySchema = z.object({
	days_requested: z.int(),
	days_with_records: z.int(),
	days_scored: z.int(),
	nap_count: z.int(),
	sleep_performance_percentage: spreadSchema,
	time_in_bed_milli: spreadSchema,
	sleep_efficiency_percentage: spreadSchema,
	stage_totals: z.object({
		light_milli: z.number(),
		sws_milli: z.number(),
		rem_milli: z.number(),
		awake_milli: z.number(),
	}),
	per_day: z.array(
		z.object({
			day: z.string(),
			score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
			sleep_performance_percentage: z.number().nullable(),
			time_in_bed_milli: z.number().nullable(),
			sleep_efficiency_percentage: z.number().nullable(),
		}),
	),
});

export type SleepSummary = z.infer<typeof sleepSummarySchema>;
type SleepScore = NonNullable<WhoopSleep["score"]>;

function totalStage(
	scores: readonly SleepScore[],
	read: (stages: SleepScore["stage_summary"]) => number,
): number {
	return scores.reduce((total, score) => total + read(score.stage_summary), 0);
}

/** Builds a sleep digest from already-fetched WHOOP records. */
export function buildSleepSummary(
	sleeps: readonly WhoopSleep[],
	daysRequested: number,
): SleepSummary {
	const nights = sleeps.filter((sleep) => !sleep.nap).slice(0, daysRequested);
	const oldestNight = nights.at(-1);
	const oldestDay =
		oldestNight === undefined ? undefined : getLocalDate(oldestNight);
	const naps = sleeps.filter(
		(sleep) =>
			sleep.nap &&
			(oldestDay === undefined || getLocalDate(sleep) >= oldestDay),
	);
	const scored = nights
		.map((night) => night.score)
		.filter((score) => score !== null && score !== undefined);
	const inBed = scored.map(
		(score) => score.stage_summary.total_in_bed_time_milli,
	);
	const performance = scored
		.map((score) => score.sleep_performance_percentage)
		.filter((value) => value !== null && value !== undefined);
	const efficiency = scored
		.map((score) => score.sleep_efficiency_percentage)
		.filter((value) => value !== null && value !== undefined);

	return {
		days_requested: daysRequested,
		days_with_records: nights.length,
		days_scored: scored.length,
		nap_count: naps.length,
		sleep_performance_percentage: calculateSpread(
			performance,
			roundToHundredths,
		),
		time_in_bed_milli: calculateSpread(inBed, Math.round),
		sleep_efficiency_percentage: calculateSpread(efficiency, roundToHundredths),
		stage_totals: {
			light_milli: totalStage(
				scored,
				(stages) => stages.total_light_sleep_time_milli,
			),
			sws_milli: totalStage(
				scored,
				(stages) => stages.total_slow_wave_sleep_time_milli,
			),
			rem_milli: totalStage(
				scored,
				(stages) => stages.total_rem_sleep_time_milli,
			),
			awake_milli: totalStage(
				scored,
				(stages) => stages.total_awake_time_milli,
			),
		},
		per_day: nights.map((night) => ({
			day: getLocalDate(night),
			score_state: night.score_state,
			sleep_performance_percentage:
				night.score?.sleep_performance_percentage ?? null,
			time_in_bed_milli:
				night.score?.stage_summary.total_in_bed_time_milli ?? null,
			sleep_efficiency_percentage:
				night.score?.sleep_efficiency_percentage ?? null,
		})),
	};
}

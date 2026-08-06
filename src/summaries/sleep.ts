import { z } from "zod";

import type { WhoopSleep } from "@/api/data/sleeps";
import { dayOf } from "./day";
import { spreadOf, spreadSchema, toHundredths } from "./spread";

/**
 * The fixed shape a sleep summary answers in: the counts that say how much of
 * the asked-for window WHOOP actually holds, the spread of each nightly metric
 * over the scored nights, the sleep stages beneath them, and one row per night.
 * No trend verdict — the per-day rows carry the signal.
 */
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
			// WHOOP's own state for the night, or ABSENT for a covered day it
			// holds no sleep for.
			score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
			sleep_performance_percentage: z.number().nullable(),
			time_in_bed_milli: z.number().nullable(),
			sleep_efficiency_percentage: z.number().nullable(),
		}),
	),
});

export type SleepSummary = z.infer<typeof sleepSummarySchema>;

/** A sleep WHOOP has finished scoring, as its score reads. */
type SleepScore = NonNullable<WhoopSleep["score"]>;

/** One stage's milliseconds, added up across the scored nights. */
function stageTotal(
	scores: readonly SleepScore[],
	read: (stages: SleepScore["stage_summary"]) => number,
): number {
	return scores.reduce((total, score) => total + read(score.stage_summary), 0);
}

/**
 * Digests WHOOP sleeps into the summary of the most recent `daysRequested`
 * nights.
 *
 * Nights are the non-naps, taken in the order WHOOP lists them — newest first.
 * Naps are counted apart and kept out of every nightly statistic: they are a
 * fact about the window, not a night in it. A night WHOOP has not scored still
 * gets its row, carrying its state and nulls, and counts as a day with a record
 * without counting as a scored one.
 */
export function summarizeSleeps(
	sleeps: readonly WhoopSleep[],
	daysRequested: number,
): SleepSummary {
	const nights = sleeps.filter((sleep) => !sleep.nap).slice(0, daysRequested);
	// The window the summary covers reaches back to its oldest night; naps older
	// than that belong to days this summary does not speak for.
	const oldestNight = nights.at(-1);
	const oldestDay = oldestNight === undefined ? undefined : dayOf(oldestNight);
	const naps = sleeps.filter(
		(sleep) =>
			sleep.nap && (oldestDay === undefined || dayOf(sleep) >= oldestDay),
	);

	const scored = nights.map((night) => night.score).filter((score) => !!score);
	const inBed = scored.map(
		(score) => score.stage_summary.total_in_bed_time_milli,
	);
	const performance = scored
		.map((score) => score.sleep_performance_percentage)
		.filter((value) => value != null);
	const efficiency = scored
		.map((score) => score.sleep_efficiency_percentage)
		.filter((value) => value != null);

	return {
		days_requested: daysRequested,
		days_with_records: nights.length,
		days_scored: scored.length,
		nap_count: naps.length,
		sleep_performance_percentage: spreadOf(performance, toHundredths),
		time_in_bed_milli: spreadOf(inBed, Math.round),
		sleep_efficiency_percentage: spreadOf(efficiency, toHundredths),
		stage_totals: {
			light_milli: stageTotal(
				scored,
				(stages) => stages.total_light_sleep_time_milli,
			),
			sws_milli: stageTotal(
				scored,
				(stages) => stages.total_slow_wave_sleep_time_milli,
			),
			rem_milli: stageTotal(
				scored,
				(stages) => stages.total_rem_sleep_time_milli,
			),
			awake_milli: stageTotal(
				scored,
				(stages) => stages.total_awake_time_milli,
			),
		},
		per_day: nights.map((night) => ({
			day: dayOf(night),
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

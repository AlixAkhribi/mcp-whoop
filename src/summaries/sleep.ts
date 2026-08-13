/**
 * @file The sleep digest: the shape it answers in, the digest that fills that
 * shape, and the one path that reads WHOOP for it.
 *
 * The read sits here, outside both surfaces, because the two must not drift:
 * the `get_sleep_summary` tool is what a model reaches for and the
 * `whoop://sleep/last-week` resource is what a user attaches, but they are one
 * question with one answer — and the JSON is rendered once, here, so the text
 * they hand over is byte-for-byte the same text.
 */

import { z } from "zod";

import { fetchSleepPage, type WhoopSleep } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireGrant } from "@/auth/tokens/granted-scopes";
import { requireStoredLogin } from "@/auth/tokens/stored-login";
import { dayOf } from "./day";
import { spreadOf, spreadSchema, toHundredths } from "./spread";

/**
 * The scope an answer here is assembled from: the nights themselves. It is
 * named beside the read that needs it because both surfaces gate on it — the
 * tool a model reaches for and the resource a user attaches — and a grant
 * without it buys neither.
 */
export const SLEEP_SUMMARY_SCOPES = ["read:sleep"] as const;

/**
 * A week, the span the question "how did I sleep lately" usually means, and the
 * range an answer takes when nobody names one.
 *
 * It is the shared path's own default rather than the tool schema's, so the
 * `whoop://sleep/last-week` resource — which has no arguments to fall back
 * from — reaches the very same week a no-argument tool call does, by running
 * the same line of code rather than by copying a number out of an input schema.
 */
export const SLEEP_SUMMARY_DEFAULT_DAYS = 7;

/** As far back as a summary reaches; longer windows belong to `list_sleeps`. */
export const SLEEP_SUMMARY_MAX_DAYS = 30;

/** WHOOP's largest page, so a week of nights costs one round trip. */
const PAGE_LIMIT = 25;

/**
 * How many pages a walk will follow before it stops. A month of nights fits in
 * two full pages; the ceiling is what keeps a chain of nap-only pages — or a
 * next_token that never ends — from walking forever.
 */
const MAX_PAGES = 8;

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

/**
 * Walks WHOOP's sleep collection from the newest sleep back, following the
 * next_token chain only as far as the asked-for nights require, and stopping
 * early on the last page WHOOP has.
 */
async function fetchSleepsFor(
	accessToken: string,
	days: number,
	signal?: AbortSignal,
): Promise<WhoopSleep[]> {
	const collected: WhoopSleep[] = [];
	let nextToken: string | undefined;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		// Sequential by nature: each page is addressed by the token the one
		// before it named.
		const answered = await fetchSleepPage(
			accessToken,
			{ limit: PAGE_LIMIT, nextToken },
			undefined,
			signal,
		);
		collected.push(...answered.records);

		const nights = collected.filter((sleep) => !sleep.nap).length;
		if (nights >= days || !answered.next_token) {
			break;
		}
		nextToken = answered.next_token;
	}

	return collected;
}

/**
 * The digest, answered once and readable two ways: the fixed-shape summary for
 * a surface that carries structure, and the one canonical rendering of it for a
 * surface that carries text.
 */
export type SleepSummaryAnswer = {
	/** The summary itself, in the shape `sleepSummarySchema` fixes. */
	readonly summary: SleepSummary;
	/** That summary as JSON — the exact text every surface hands over. */
	readonly json: string;
};

/**
 * Reads the most recent `days` of WHOOP sleep whole: the stored login, the
 * collection walked back as far as the window reaches, and the digest of what
 * came back — the answer both the `get_sleep_summary` tool and the
 * `whoop://sleep/last-week` resource hand over.
 *
 * Unasked, it is {@link SLEEP_SUMMARY_DEFAULT_DAYS}: the resource names no
 * range and the tool's schema falls back to that same constant, so the two
 * cannot disagree about what "lately" means.
 */
export async function answerSleepSummary(
	days: number = SLEEP_SUMMARY_DEFAULT_DAYS,
	signal?: AbortSignal,
): Promise<SleepSummaryAnswer> {
	const tokens = await requireStoredLogin();
	// Judged on the grant as it stands now, whichever surface asked: the login
	// can be redone mid-connection, and the answer belongs to the current one.
	requireGrant(tokens.scopes, ...SLEEP_SUMMARY_SCOPES);

	const sleeps = await withValidAccessToken(tokens, (accessToken) =>
		fetchSleepsFor(accessToken, days, signal),
	);
	const summary = summarizeSleeps(sleeps, days);

	return { summary, json: JSON.stringify(summary, null, "\t") };
}

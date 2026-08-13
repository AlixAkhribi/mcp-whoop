/**
 * @file The recovery digest: the shape it answers in, the digest that fills
 * that shape, and the one path that reads WHOOP for it.
 *
 * The read sits here, outside both surfaces, because the two must not drift:
 * the `get_recovery_summary` tool is what a model reaches for and the
 * `whoop://recovery/last-week` resource is what a user attaches, but they are
 * one question with one answer — and the JSON is rendered once, here, so the
 * text they hand over is byte-for-byte the same text.
 */

import { z } from "zod";

import { fetchCyclePage, type WhoopCycle } from "@/api/data/cycles";
import { fetchRecoveryPage, type WhoopRecovery } from "@/api/data/recoveries";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireGrant } from "@/auth/tokens/granted-scopes";
import { requireStoredLogin } from "@/auth/tokens/stored-login";
import { dayOf } from "./day";
import { type Spread, spreadOf, spreadSchema, toHundredths } from "./spread";

/**
 * The scopes an answer here is assembled from: the cycles that are the days,
 * and the recoveries scored against them. They are named beside the reads that
 * need them because both surfaces gate on them — the tool a model reaches for
 * and the resource a user attaches — and a grant holding one without the other
 * would only buy a digest that fails on the listing it was not allowed to read.
 */
export const RECOVERY_SUMMARY_SCOPES = [
	"read:cycles",
	"read:recovery",
] as const;

/**
 * A week, the span the question "how is my recovery lately" usually means, and
 * the range an answer takes when nobody names one.
 *
 * It is the shared path's own default rather than the tool schema's, so the
 * `whoop://recovery/last-week` resource — which has no arguments to fall back
 * from — reaches the very same week a no-argument tool call does, by running
 * the same line of code rather than by copying a number out of an input schema.
 */
export const RECOVERY_SUMMARY_DEFAULT_DAYS = 7;

/**
 * As far back as a summary reaches; longer windows belong to `list_cycles` and
 * `list_recoveries`.
 */
export const RECOVERY_SUMMARY_MAX_DAYS = 30;

/** WHOOP's largest page, so a week of days costs one round trip per listing. */
const PAGE_LIMIT = 25;

/**
 * How many pages a walk will follow before it stops. A month of days fits in
 * two full pages; the ceiling is what keeps a next_token that never ends from
 * walking forever.
 */
const MAX_PAGES = 8;

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

/** One page of a WHOOP collection, as every paginated listing answers. */
type Page<T> = {
	records: T[];
	next_token?: string | null;
};

/**
 * Walks a WHOOP collection from its newest record back — the open cycle
 * included — following the next_token chain only as far as the asked-for days
 * require, and stopping early on the last page WHOOP has.
 *
 * Both listings this summary reads run newest first, and a cycle has at most
 * one recovery, so as many records as there are days in the window always reach
 * back at least as far as the window does — whatever the join then pairs up.
 */
async function collectRecent<T>(
	days: number,
	readPage: (nextToken: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
	const collected: T[] = [];
	let nextToken: string | undefined;

	for (let page = 0; page < MAX_PAGES; page += 1) {
		// Sequential by nature: each page is addressed by the token the one
		// before it named.
		const answered = await readPage(nextToken);
		collected.push(...answered.records);

		if (collected.length >= days || !answered.next_token) {
			break;
		}
		nextToken = answered.next_token;
	}

	return collected;
}

/** The most recent cycles — the days this summary speaks for. */
function fetchCyclesFor(
	accessToken: string,
	days: number,
	signal?: AbortSignal,
): Promise<WhoopCycle[]> {
	return collectRecent(days, (nextToken) =>
		fetchCyclePage(
			accessToken,
			{ limit: PAGE_LIMIT, nextToken },
			undefined,
			signal,
		),
	);
}

/** The recoveries that reach back over those days, to be joined to them. */
function fetchRecoveriesFor(
	accessToken: string,
	days: number,
	signal?: AbortSignal,
): Promise<WhoopRecovery[]> {
	return collectRecent(days, (nextToken) =>
		fetchRecoveryPage(
			accessToken,
			{ limit: PAGE_LIMIT, nextToken },
			undefined,
			signal,
		),
	);
}

/**
 * The digest, answered once and readable two ways: the fixed-shape summary for
 * a surface that carries structure, and the one canonical rendering of it for a
 * surface that carries text.
 */
export type RecoverySummaryAnswer = {
	/** The summary itself, in the shape `recoverySummarySchema` fixes. */
	readonly summary: RecoverySummary;
	/** That summary as JSON — the exact text every surface hands over. */
	readonly json: string;
};

/**
 * Reads the most recent `days` of WHOOP recovery whole: the stored login, both
 * listings walked back as far as the window reaches, and the digest they join
 * into — the answer both the `get_recovery_summary` tool and the
 * `whoop://recovery/last-week` resource hand over.
 *
 * Unasked, it is {@link RECOVERY_SUMMARY_DEFAULT_DAYS}: the resource names no
 * range and the tool's schema falls back to that same constant, so the two
 * cannot disagree about what "lately" means.
 */
export async function answerRecoverySummary(
	days: number = RECOVERY_SUMMARY_DEFAULT_DAYS,
	signal?: AbortSignal,
): Promise<RecoverySummaryAnswer> {
	const tokens = await requireStoredLogin();
	// Judged on the grant as it stands now, whichever surface asked: the login
	// can be redone mid-connection, and the answer belongs to the current one.
	requireGrant(tokens.scopes, ...RECOVERY_SUMMARY_SCOPES);

	const summary = await withValidAccessToken(tokens, async (accessToken) => {
		const cycles = await fetchCyclesFor(accessToken, days, signal);
		const recoveries = await fetchRecoveriesFor(accessToken, days, signal);

		return summarizeRecoveries(cycles, recoveries, days);
	});

	return { summary, json: JSON.stringify(summary, null, "\t") };
}

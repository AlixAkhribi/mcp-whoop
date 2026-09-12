import { WHOOP_MAX_PAGE_SIZE } from "@/whoop/api/data/common";
import { fetchCyclePage } from "@/whoop/api/data/cycles";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { TODAY_SNAPSHOT_SCOPES } from "@/whoop/auth/tokens/scopes";
import { getCycleWakeDate, openingSleepsByCycle } from "./day";
import { fetchSleepsNaming } from "./night-walk";
import { collectPagesUntil } from "./pagination";
import { createWakeDatesMemo } from "./recent-days-memo";

/**
 * How far this read reaches back: the thirty most recent cycles WHOOP holds.
 *
 * A count of cycles rather than a span of the clock, the way the summaries
 * count days: WHOOP's collections are walked newest first, so a count is the
 * one bound that stops the walk without asking what today's date is. A user
 * WHOOP holds a gappy history for is offered their thirty most recent days,
 * not whichever of the last thirty calendar dates they happened to wear it on.
 * And a count of cycles, not of dates: thirty cycles holding a short day
 * yield twenty-nine dates, and the read does not reach for a thirty-first
 * cycle to make the count up.
 */
const RECENT_DAY_COUNT = 30;

/**
 * This process's own memo of the last listing, so the completions of one
 * conversation ask WHOOP once while a user types (`./recent-days-memo`).
 */
const wakeDatesMemo = createWakeDatesMemo();

/**
 * The days a run of cycles is named by: each cycle labeled by the wake-day
 * rule (`./day`), and each date kept once — in the order the cycles
 * came, newest first the way WHOOP lists, the first occurrence keeping its
 * place.
 *
 * One date can label two of the cycles: a short day files two cycles whose
 * opening sleeps end the same morning, and a cycle WHOOP recorded no sleep
 * for falls back onto the date its start falls on — the previous morning's
 * label. These are days, not cycles, so each such date surfaces once: a
 * listing of the days a login has lived that names a day twice is the lie.
 */
export function wakeDatesOfCycles<
	Cycle extends { id: number; start: string; timezone_offset: string },
	Sleep extends {
		cycle_id?: number | null;
		nap: boolean;
		end: string;
		timezone_offset: string;
	},
>(cycles: readonly Cycle[], sleeps: readonly Sleep[]): string[] {
	const openingSleeps = openingSleepsByCycle(sleeps);

	return [
		...new Set(
			cycles.map((cycle) =>
				getCycleWakeDate(cycle, openingSleeps.get(cycle.id)),
			),
		),
	];
}

/**
 * The dates naming the most recent days this login has lived, newest first
 * and each date once (`wakeDatesOfCycles`) — each one a date
 * `whoop://day/{date}` could be read at, labeled by the very rule that read
 * is answered under. Days, not cycles: the de-duplication belongs
 * here, to the listing itself, not to the narrowing below — and the whole
 * unique list is handed on, so the protocol library stays the only cap and
 * derives `total` and `hasMore` from the matches.
 *
 * Read under the same three scopes a day snapshot is, though no recovery is
 * fetched here: a date this read offered but that read could not answer would
 * be a suggestion leading nowhere, so the narrower grant refuses here too,
 * naming what is missing.
 *
 * The order is WHOOP's own — its collections list newest first, which is what
 * makes "the thirty most recent" a walk that can stop — so the days come back
 * in the order the summaries already report theirs in.
 *
 * Answered from this process's memo when the same access token asked within
 * the last minute (`./recent-days-memo`), so the consecutive completions of
 * one conversation list once while a user types. Only the completion comes
 * through here: a day read promises a zero lifetime and fetches afresh.
 */
export async function readRecentWakeDates({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<string[]> {
	return withAuthorizedWhoopAccess(
		TODAY_SNAPSHOT_SCOPES,
		({ accessToken, signal: requestSignal }) =>
			wakeDatesMemo.serve(accessToken, async () => {
				const listed = await collectPagesUntil({
					readPage: (nextToken) =>
						fetchCyclePage(
							accessToken,
							{ limit: WHOOP_MAX_PAGE_SIZE, nextToken },
							{ signal: requestSignal },
						),
					isComplete: (records) => records.length >= RECENT_DAY_COUNT,
				});
				// A page overshoots — WHOOP hands back whole pages, and the walk stops
				// at or past the count rather than on it — so the surplus is dropped
				// here, the way a summary drops what its own day count does not span.
				const cycles = listed.slice(0, RECENT_DAY_COUNT);
				const sleeps = await fetchSleepsNaming(accessToken, cycles, {
					signal: requestSignal,
				});

				return wakeDatesOfCycles(cycles, sleeps);
			}),
		{ signal },
	);
}

/**
 * The days among `dates` a half-typed date narrows to: those it is the start
 * of. Prefix matching, because that is how a date is typed — left to right,
 * year then month then day — so every keystroke narrows what is still reachable
 * rather than reshuffling it.
 *
 * Deliberately uncapped: how many suggestions may travel is the protocol's
 * business, and the SDK cuts the answer to a hundred and says so in `hasMore`.
 * Capping here as well would make `total` count the cut list rather than the
 * matches, and tell a client there was nothing more when there was.
 */
export function datesStartingWith(
	dates: readonly string[],
	typed: string,
): string[] {
	return dates.filter((date) => date.startsWith(typed));
}

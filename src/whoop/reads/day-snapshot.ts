import { WHOOP_MAX_PAGE_SIZE } from "@/whoop/api/data/common";
import { fetchCyclePage } from "@/whoop/api/data/cycles";
import { fetchCycleRecoveryOrAbsent } from "@/whoop/api/data/recoveries";
import { fetchSleepPage } from "@/whoop/api/data/sleeps";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { TODAY_SNAPSHOT_SCOPES } from "@/whoop/auth/tokens/scopes";
import { findCycleByWakeDate, NoSuchDayError, parseWakeDate } from "./day";
import { buildDaySnapshot, type DaySnapshot } from "./day-snapshot-model";

const DAY_MS = 86_400_000;

/**
 * How far either side of the date's UTC midnight a window reaches: two days.
 *
 * A wake on one date can fall anywhere in the 26 hours the world's offsets
 * spread it over, and the sleep that ended in it began a night earlier still,
 * so one day either side would already be tight at the edges. Two is the same
 * bound with a day of slack, and still a window — a handful of records, one
 * page each, rather than a walk back through a history.
 */
const WINDOW_DAYS = 2;

/**
 * The window of instants to ask WHOOP's collections for. WHOOP has no read by
 * date: its collections take a window and answer with whatever intersects it,
 * so the date is turned into instants here and matched against each record's
 * own label afterwards.
 */
function windowAround(wakeDate: string): { start: string; end: string } {
	const midnight = Date.parse(`${wakeDate}T00:00:00.000Z`);

	return {
		start: new Date(midnight - WINDOW_DAYS * DAY_MS).toISOString(),
		end: new Date(midnight + WINDOW_DAYS * DAY_MS).toISOString(),
	};
}

/** WHOOP's answer for a date it holds no cycle for — said as the date asked. */
function noDayFor(wakeDate: string): string {
	return `WHOOP has no day for ${wakeDate}: no cycle was woken into that morning.`;
}

/**
 * Reads the day the current login woke into on `date` — the same snapshot
 * `readTodaySnapshot` answers for the open cycle, addressed by its date
 * instead. Under the same three scopes: a day is a cycle, its recovery and the
 * sleep that both opened and named it.
 *
 * @throws {NoSuchDayError} When the date is not a real calendar date, or WHOOP
 * holds no cycle that was woken into on it — the two ways there is no such day
 * to read, told apart from this server failing to read a day that is there.
 */
export async function readDaySnapshot(
	date: string,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<DaySnapshot> {
	const wakeDate = parseWakeDate(date);
	const window = windowAround(wakeDate);

	return withAuthorizedWhoopAccess(
		TODAY_SNAPSHOT_SCOPES,
		async ({ accessToken, signal: requestSignal }) => {
			// The sleeps are not decoration: a cycle is labeled by the end of the
			// sleep carrying its id, so naming the day at all takes both
			// collections. One page each — a window this wide holds a handful of
			// records, not a history.
			const [cycles, sleeps] = await Promise.all([
				fetchCyclePage(
					accessToken,
					{ ...window, limit: WHOOP_MAX_PAGE_SIZE },
					{ signal: requestSignal },
				),
				fetchSleepPage(
					accessToken,
					{ ...window, limit: WHOOP_MAX_PAGE_SIZE },
					{ signal: requestSignal },
				),
			]);
			const day = findCycleByWakeDate(cycles.records, sleeps.records, wakeDate);
			if (day === undefined) {
				throw new NoSuchDayError(noDayFor(wakeDate));
			}
			const recovery = await fetchCycleRecoveryOrAbsent(
				accessToken,
				day.cycle.id,
				{ signal: requestSignal },
			);

			return buildDaySnapshot(day.cycle, recovery, day.openingSleep ?? null);
		},
		{ signal },
	);
}

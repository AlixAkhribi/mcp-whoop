/**
 * There is no such day to read: the date names nothing WHOOP holds a cycle
 * for, or is not a date this server can read at all. Its own class so a
 * surface addressing days by URI can answer it as the miss it is — a member of
 * the family that does not exist — rather than as this server failing to
 * answer a day it does have.
 */
export class NoSuchDayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoSuchDayError";
	}
}

/** A date in the only form a day is addressed by: a `YYYY-MM-DD` wake day. */
const WAKE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The date an instant falls on in UTC — the form WHOOP's windows are stated in. */
function utcDate(instant: number): string {
	return new Date(instant).toISOString().slice(0, 10);
}

/**
 * Reads a date as a wake day, insisting it be a real calendar date
 * written the one way this server accepts.
 *
 * The round trip is what makes it strict: `Date` rolls an impossible date over
 * rather than refusing it — the 30th of February parses as the 2nd of March —
 * and a day quietly answered under a date nobody asked for is worse than a
 * refusal. The pattern is what makes it narrow: it anchors both ends, so an
 * unpadded month, a word, or anything dragged along behind the date is no date
 * at all rather than a prefix that happens to parse.
 *
 * @throws {NoSuchDayError} When the date is not a real `YYYY-MM-DD` calendar
 * date.
 */
export function parseWakeDate(date: string): string {
	const parsed = WAKE_DATE_PATTERN.test(date)
		? Date.parse(`${date}T00:00:00.000Z`)
		: Number.NaN;
	if (Number.isNaN(parsed) || utcDate(parsed) !== date) {
		throw new NoSuchDayError(
			`"${date}" is not a date this server can read. A day is named by the morning you woke, written as YYYY-MM-DD — for example 2026-08-04.`,
		);
	}

	return date;
}

/** Anything WHOOP stamps with a start and the offset it was lived at. */
type LocallyStarted = {
	start: string;
	timezone_offset: string;
};

/** Anything WHOOP stamps with an end and the offset it was lived at. */
type LocallyEnded = {
	end: string;
	timezone_offset: string;
};

/** WHOOP's timezone offset, in the `±HH:MM` form the records carry. */
const OFFSET_PATTERN = /^([+-])(\d{2}):?(\d{2})$/;

/** The offset in minutes; a form we cannot read falls back to 0, labeling the day by UTC. */
function offsetMinutes(offset: string): number {
	const parts = OFFSET_PATTERN.exec(offset);
	if (!parts) {
		return 0;
	}
	const magnitude = Number(parts[2]) * 60 + Number(parts[3]);

	return parts[1] === "-" ? -magnitude : magnitude;
}

/**
 * The date an instant falls on where it was lived — read at the offset the
 * record carries, never at wherever this process happens to run, and at UTC
 * only when that offset is unreadable.
 */
function dateAtOffset(instant: string, offset: string): string {
	return new Date(Date.parse(instant) + offsetMinutes(offset) * 60_000)
		.toISOString()
		.slice(0, 10);
}

/**
 * The wake day a sleep belongs to: the date its own end falls on,
 * read at the offset that record carries — the morning the user woke into, and
 * the date WHOOP's own app files the sleep under. A sleep belongs to the day it
 * opens, so it is named by the morning it ended on, never by the evening it
 * began and never by whatever date the instant happens to be in UTC.
 */
export function getWakeDate(record: LocallyEnded): string {
	return dateAtOffset(record.end, record.timezone_offset);
}

/**
 * The wake day a cycle belongs to: the date the sleep carrying that
 * cycle's id ended on, read at the offset that sleep carries — the morning the
 * user was woken into the cycle. WHOOP bounds the cycle itself at sleep onset,
 * so its start is the evening before: a boundary, never a label while there is
 * a wake to name the day by.
 *
 * A cycle WHOOP recorded no opening sleep for has no such wake, and falls back
 * to the date its own start falls on — the nearest fact WHOOP holds about it.
 */
export function getCycleWakeDate(
	cycle: LocallyStarted,
	openingSleep: LocallyEnded | undefined,
): string {
	return openingSleep === undefined
		? dateAtOffset(cycle.start, cycle.timezone_offset)
		: getWakeDate(openingSleep);
}

/** Anything WHOOP joins back to a cycle, and files as a night or a nap. */
type CycleOpening = LocallyEnded & {
	cycle_id?: number | null;
	nap: boolean;
};

/**
 * The sleep that opened each cycle, by the id it carries back. Naps are left
 * out: WHOOP stamps one with its cycle's id too, and no nap is a morning
 * anybody was woken into.
 */
export function openingSleepsByCycle<Sleep extends CycleOpening>(
	sleeps: readonly Sleep[],
): Map<number | null | undefined, Sleep> {
	return new Map(
		sleeps
			.filter((sleep) => !sleep.nap)
			.map((sleep) => [sleep.cycle_id, sleep]),
	);
}

/** One cycle-day: the cycle a date names, and the sleep that opened it. */
export type CycleDay<Cycle, Sleep> = {
	readonly cycle: Cycle;
	readonly openingSleep: Sleep | undefined;
};

/**
 * The cycle a date names: the one whose opening sleep ended that
 * morning, found among the cycles and sleeps a window of instants brought back.
 * WHOOP has no read by date — its collections take a window and answer with
 * whatever intersects it — so the date is matched against each cycle's own
 * label rather than against any boundary of the window.
 *
 * A date can name two cycles: on a rare short day the user goes back to bed
 * after waking, WHOOP bounds a second cycle at that second onset, and both
 * cycles' opening sleeps end the same morning. The date resolves to the one
 * that started later — the day as WHOOP last filed it — and the earlier one is
 * not addressable by date. Which is decided by the cycles' own starts, never by
 * the order WHOOP happened to list them in.
 *
 * Nothing is returned when no cycle in hand was woken into on that date: a day
 * WHOOP holds no cycle for is not a day this server can speak for.
 */
export function findCycleByWakeDate<
	Cycle extends LocallyStarted & { id: number },
	Sleep extends CycleOpening,
>(
	cycles: readonly Cycle[],
	sleeps: readonly Sleep[],
	wakeDate: string,
): CycleDay<Cycle, Sleep> | undefined {
	const openings = openingSleepsByCycle(sleeps);
	let named: CycleDay<Cycle, Sleep> | undefined;

	for (const cycle of cycles) {
		const openingSleep = openings.get(cycle.id);
		if (getCycleWakeDate(cycle, openingSleep) !== wakeDate) {
			continue;
		}
		if (
			named === undefined ||
			Date.parse(cycle.start) > Date.parse(named.cycle.start)
		) {
			named = { cycle, openingSleep };
		}
	}

	return named;
}

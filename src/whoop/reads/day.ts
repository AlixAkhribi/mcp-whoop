/** Anything WHOOP stamps with a start and the offset it was lived at. */
type LocallyStarted = {
	start: string;
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
 * The day a record belongs to: the date its start falls on read at the offset
 * that record itself carries, so a day is labeled by where the user was —
 * never by wherever this process happens to run, and by UTC only when the
 * record's offset is unreadable.
 */
export function getLocalDate(record: LocallyStarted): string {
	const startedAt = Date.parse(record.start);

	return new Date(startedAt + offsetMinutes(record.timezone_offset) * 60_000)
		.toISOString()
		.slice(0, 10);
}

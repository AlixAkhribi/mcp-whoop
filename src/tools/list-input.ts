import { z } from "zod";
import { WHOOP_MAX_PAGE_SIZE } from "@/whoop/api/data/common";

/** Keeps WHOOP's shared pagination constraints identical across list tools. */
export function listInputSchemaFor(recordLabel: string) {
	return z.strictObject({
		start: z.iso
			.datetime({ offset: true })
			.optional()
			.describe(
				`Only ${recordLabel} that occurred during or after (inclusive) this ISO 8601 time.`,
			),
		end: z.iso
			.datetime({ offset: true })
			.optional()
			.describe(
				`Only ${recordLabel} that intersect this ISO 8601 time or ended before (exclusive) it. Defaults to now.`,
			),
		limit: z
			.int()
			.min(1)
			.max(WHOOP_MAX_PAGE_SIZE)
			.optional()
			.describe(
				`How many ${recordLabel} to return at most (default 10, max ${WHOOP_MAX_PAGE_SIZE}).`,
			),
		nextToken: z
			.string()
			.min(1)
			.optional()
			.describe(
				"The next_token of the previous page, to get the page after it. Omit for the first page.",
			),
	});
}

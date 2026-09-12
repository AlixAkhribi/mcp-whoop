import { WHOOP_MAX_PAGE_SIZE } from "@/whoop/api/data/common";
import { fetchSleepPage, type WhoopSleep } from "@/whoop/api/data/sleeps";
import { collectPagesUntil } from "./pagination";

/**
 * Reads sleeps back to the oldest of the cycles in hand — the nights are not
 * decoration: a cycle is named by the end of the sleep carrying its id
 * (`./day`), so naming these days at all takes both collections.
 * The sleep that opens a cycle starts where that cycle starts — WHOOP's own
 * boundary — so a listing reaching the oldest cycle's start holds every night
 * one of these days can be named by. The cycles come as WHOOP lists them,
 * newest first, so the oldest is the last in hand.
 *
 * Bounded by that instant rather than by a count of nights: a cycle WHOOP
 * recorded no sleep for makes the two collections different lengths, and a
 * count would then stop short of the oldest day or walk past it. And no cycle
 * at all means no day to name, and asks for nothing.
 */
export async function fetchSleepsNaming(
	accessToken: string,
	cycles: readonly { start: string }[],
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhoopSleep[]> {
	const oldestCycle = cycles.at(-1);
	if (oldestCycle === undefined) {
		return [];
	}
	const boundary = Date.parse(oldestCycle.start);

	return collectPagesUntil({
		readPage: (nextToken) =>
			fetchSleepPage(
				accessToken,
				{ limit: WHOOP_MAX_PAGE_SIZE, nextToken },
				{ signal },
			),
		isComplete: (records) => {
			const oldest = records.at(-1);

			return oldest !== undefined && Date.parse(oldest.start) <= boundary;
		},
	});
}

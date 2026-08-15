import { WHOOP_MAX_PAGE_SIZE } from "@/whoop/api/data/common";
import { fetchSleepPage, type WhoopSleep } from "@/whoop/api/data/sleeps";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { SLEEP_SUMMARY_SCOPES } from "@/whoop/auth/tokens/scopes";
import { collectPagesUntil } from "./pagination";
import { buildSleepSummary, type SleepSummary } from "./sleep-summary-model";

export { sleepSummarySchema } from "./sleep-summary-model";

export const SLEEP_SUMMARY_DEFAULT_DAYS = 7;
export const SLEEP_SUMMARY_MAX_DAYS = 30;

function fetchSleepsFor(
	accessToken: string,
	days: number,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhoopSleep[]> {
	return collectPagesUntil({
		readPage: (nextToken) =>
			fetchSleepPage(
				accessToken,
				{ limit: WHOOP_MAX_PAGE_SIZE, nextToken },
				{ signal },
			),
		isComplete: (records) =>
			records.filter((sleep) => !sleep.nap).length >= days,
	});
}

/** Reads and calculates the current login's recent sleep summary. */
export async function readSleepSummary({
	days = SLEEP_SUMMARY_DEFAULT_DAYS,
	signal,
}: {
	days?: number;
	signal?: AbortSignal;
} = {}): Promise<SleepSummary> {
	const sleeps = await withAuthorizedWhoopAccess(
		SLEEP_SUMMARY_SCOPES,
		({ accessToken, signal: requestSignal }) =>
			fetchSleepsFor(accessToken, days, { signal: requestSignal }),
		{ signal },
	);

	return buildSleepSummary(sleeps, days);
}

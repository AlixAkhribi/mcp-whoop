import { WHOOP_MAX_PAGE_SIZE } from "@/whoop/api/data/common";
import { fetchCyclePage, type WhoopCycle } from "@/whoop/api/data/cycles";
import {
	fetchRecoveryPage,
	type WhoopRecovery,
} from "@/whoop/api/data/recoveries";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { RECOVERY_SUMMARY_SCOPES } from "@/whoop/auth/tokens/scopes";
import { collectPagesUntil } from "./pagination";
import {
	buildRecoverySummary,
	type RecoverySummary,
} from "./recovery-summary-model";

export { recoverySummarySchema } from "./recovery-summary-model";

export const RECOVERY_SUMMARY_DEFAULT_DAYS = 7;
export const RECOVERY_SUMMARY_MAX_DAYS = 30;

function fetchCyclesFor(
	accessToken: string,
	days: number,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhoopCycle[]> {
	return collectPagesUntil({
		readPage: (nextToken) =>
			fetchCyclePage(
				accessToken,
				{ limit: WHOOP_MAX_PAGE_SIZE, nextToken },
				{ signal },
			),
		isComplete: (records) => records.length >= days,
	});
}

function fetchRecoveriesFor(
	accessToken: string,
	days: number,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhoopRecovery[]> {
	return collectPagesUntil({
		readPage: (nextToken) =>
			fetchRecoveryPage(
				accessToken,
				{ limit: WHOOP_MAX_PAGE_SIZE, nextToken },
				{ signal },
			),
		isComplete: (records) => records.length >= days,
	});
}

/** Reads and calculates the current login's recent recovery summary. */
export async function readRecoverySummary({
	days = RECOVERY_SUMMARY_DEFAULT_DAYS,
	signal,
}: {
	days?: number;
	signal?: AbortSignal;
} = {}): Promise<RecoverySummary> {
	return withAuthorizedWhoopAccess(
		RECOVERY_SUMMARY_SCOPES,
		async ({ accessToken, signal: requestSignal }) => {
			const cycles = await fetchCyclesFor(accessToken, days, {
				signal: requestSignal,
			});
			const recoveries = await fetchRecoveriesFor(accessToken, days, {
				signal: requestSignal,
			});

			return buildRecoverySummary(cycles, recoveries, days);
		},
		{ signal },
	);
}

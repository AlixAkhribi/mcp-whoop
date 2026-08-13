/**
 * @file Today, read whole — one of the modules in this directory that reaches
 * for WHOOP itself rather than only digesting records handed to it: it sits
 * beside the shape it fills (`snapshot.ts`) because what it does is answer that
 * shape, and it sits outside both surfaces because the tool and the resource
 * have to answer identically — one path, one rendering, nothing to drift.
 */

import { fetchCyclePage, type WhoopCycle } from "@/api/data/cycles";
import { fetchCycleRecoveryOrAbsent } from "@/api/data/recoveries";
import { fetchCycleSleepOrAbsent } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireGrant } from "@/auth/tokens/granted-scopes";
import { requireStoredLogin } from "@/auth/tokens/stored-login";
import { snapshotOfToday, type TodaySnapshot } from "./snapshot";

/**
 * The scopes an answer here is assembled from: the cycle now running, the
 * recovery WHOOP scored for it and the sleep that started it. They are named
 * beside the reads that need them because both surfaces gate on them — the tool
 * a model reaches for and the resource a user attaches — and a day missing any
 * one of the three could only answer part of the question it advertises.
 */
export const TODAY_SNAPSHOT_SCOPES = [
	"read:cycles",
	"read:recovery",
	"read:sleep",
] as const;

/** Shown when WHOOP holds no cycle at all for this user — nothing to report. */
const NO_CURRENT_CYCLE =
	"WHOOP has no cycles for this user yet, so there is no current day to report.";

/**
 * The cycle now running: WHOOP lists cycles newest first, and the newest one is
 * the open one — the day still being lived, scored while it runs.
 */
async function fetchCurrentCycle(
	accessToken: string,
	signal?: AbortSignal,
): Promise<WhoopCycle> {
	const page = await fetchCyclePage(
		accessToken,
		{ limit: 1 },
		undefined,
		signal,
	);
	const current = page.records[0];
	if (current === undefined) {
		throw new Error(NO_CURRENT_CYCLE);
	}

	return current;
}

/**
 * Today, answered once and readable two ways: the fixed-shape digest for a
 * surface that carries structure, and the one canonical rendering of it for a
 * surface that carries text.
 */
export type TodayAnswer = {
	/** The snapshot itself, in the shape `todaySnapshotSchema` fixes. */
	readonly snapshot: TodaySnapshot;
	/** That snapshot as JSON — the exact text every surface hands over. */
	readonly json: string;
};

/**
 * Reads today whole: the stored login, the cycle now running, the recovery
 * WHOOP scored for it and the sleep that started it, assembled into the
 * snapshot both the `get_today_snapshot` tool and the `whoop://today` resource
 * answer with.
 *
 * It lives here, outside either surface, because the two must not drift: the
 * tool is what a model reaches for and the resource is what a user attaches,
 * but they are one question with one answer — and the JSON is rendered once,
 * here, so the text they hand over is byte-for-byte the same text.
 */
export async function answerToday(signal?: AbortSignal): Promise<TodayAnswer> {
	const tokens = await requireStoredLogin();
	// Judged on the grant as it stands now, whichever surface asked: the login
	// can be redone mid-connection, and the answer belongs to the current one.
	requireGrant(tokens.scopes, ...TODAY_SNAPSHOT_SCOPES);

	const snapshot = await withValidAccessToken(tokens, async (accessToken) => {
		const cycle = await fetchCurrentCycle(accessToken, signal);
		// Both joins hang off the cycle just read, and neither waits on the other:
		// asked together, the snapshot costs one round trip's wait rather than two.
		const [recovery, sleep] = await Promise.all([
			fetchCycleRecoveryOrAbsent(accessToken, cycle.id, undefined, signal),
			fetchCycleSleepOrAbsent(accessToken, cycle.id, undefined, signal),
		]);

		return snapshotOfToday(cycle, recovery, sleep);
	});

	return { snapshot, json: JSON.stringify(snapshot, null, "\t") };
}

import { z } from "zod";

import {
	cycleSchema,
	fetchCyclePage,
	type WhoopCycle,
} from "@/whoop/api/data/cycles";
import {
	fetchCycleRecoveryOrAbsent,
	recoverySchema,
	type WhoopRecovery,
} from "@/whoop/api/data/recoveries";
import {
	fetchCycleSleepOrAbsent,
	sleepSchema,
	type WhoopSleep,
} from "@/whoop/api/data/sleeps";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { TODAY_SNAPSHOT_SCOPES } from "@/whoop/auth/tokens/scopes";

export const todaySnapshotSchema = z.object({
	cycle: cycleSchema,
	recovery_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]),
	recovery: recoverySchema.nullable(),
	sleep: sleepSchema.nullable(),
});

type TodaySnapshot = z.infer<typeof todaySnapshotSchema>;

/** Builds the fixed-shape view shared by the today tool and resource. */
export function buildTodaySnapshot(
	cycle: WhoopCycle,
	recovery: WhoopRecovery | null,
	sleep: WhoopSleep | null,
): TodaySnapshot {
	return {
		cycle,
		recovery_state: recovery?.score_state ?? ("ABSENT" as const),
		recovery,
		sleep,
	};
}

const NO_CURRENT_CYCLE =
	"WHOOP has no cycles for this user yet, so there is no current day to report.";

async function fetchCurrentCycle(
	accessToken: string,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhoopCycle> {
	const page = await fetchCyclePage(accessToken, { limit: 1 }, { signal });
	const current = page.records[0];
	if (current === undefined) {
		throw new Error(NO_CURRENT_CYCLE);
	}

	return current;
}

/** Reads the current login's open cycle and its recovery and sleep joins. */
export async function readTodaySnapshot({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<TodaySnapshot> {
	return withAuthorizedWhoopAccess(
		TODAY_SNAPSHOT_SCOPES,
		async ({ accessToken, signal: requestSignal }) => {
			const cycle = await fetchCurrentCycle(accessToken, {
				signal: requestSignal,
			});
			const [recovery, sleep] = await Promise.all([
				fetchCycleRecoveryOrAbsent(accessToken, cycle.id, {
					signal: requestSignal,
				}),
				fetchCycleSleepOrAbsent(accessToken, cycle.id, {
					signal: requestSignal,
				}),
			]);

			return buildTodaySnapshot(cycle, recovery, sleep);
		},
		{ signal },
	);
}

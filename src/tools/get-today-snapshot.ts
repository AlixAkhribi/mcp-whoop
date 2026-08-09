import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchCyclePage, type WhoopCycle } from "@/api/data/cycles";
import { fetchCycleRecoveryOrAbsent } from "@/api/data/recoveries";
import { fetchCycleSleepOrAbsent } from "@/api/data/sleeps";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { snapshotOfToday, todaySnapshotSchema } from "@/summaries/snapshot";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";
import { requireStoredLogin } from "./stored-login";

/**
 * No input: which day "today" is follows from WHOOP, not from an argument — it
 * is the cycle currently running. Spelled as an empty `z.strictObject(...)` so
 * clients see a well-formed object schema in `tools/list` that takes no
 * properties at all, and an argument sent anyway is refused rather than quietly
 * dropped.
 */
const getTodaySnapshotInputSchema = z.strictObject({});

/** Shown when WHOOP holds no cycle at all for this user — nothing to report. */
const NO_CURRENT_CYCLE =
	"WHOOP has no cycles for this user yet, so there is no current day to report.";

/**
 * The cycle now running: WHOOP lists cycles newest first, and the newest one is
 * the open one — the day still being lived, scored while it runs.
 */
async function fetchCurrentCycle(accessToken: string): Promise<WhoopCycle> {
	const page = await fetchCyclePage(accessToken, { limit: 1 });
	const current = page.records[0];
	if (current === undefined) {
		throw new Error(NO_CURRENT_CYCLE);
	}

	return current;
}

/** Registers the `get_today_snapshot` tool on a server instance. */
export function registerGetTodaySnapshotTool(server: McpServer): void {
	server.registerTool(
		"get_today_snapshot",
		{
			title: "WHOOP today snapshot",
			description:
				'Answers "how am I today" for the user this server is logged in as, in one call: the WHOOP physiological cycle currently running with the strain accumulated in it so far, the recovery scored for that cycle, and the sleep that started it. A recovery WHOOP has not scored yet or holds none of, and a sleep it has no record of, are reported as states of the day — never as an error.',
			inputSchema: getTodaySnapshotInputSchema,
			outputSchema: todaySnapshotSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_today_snapshot", async () => {
			const tokens = await requireStoredLogin();

			const snapshot = await withValidAccessToken(
				tokens,
				async (accessToken) => {
					const cycle = await fetchCurrentCycle(accessToken);
					// Both joins hang off the cycle just read, and neither waits on the
					// other: asked together, the snapshot costs one round trip's wait
					// rather than two.
					const [recovery, sleep] = await Promise.all([
						fetchCycleRecoveryOrAbsent(accessToken, cycle.id),
						fetchCycleSleepOrAbsent(accessToken, cycle.id),
					]);

					return snapshotOfToday(cycle, recovery, sleep);
				},
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(snapshot, null, "\t") },
				],
				structuredContent: snapshot,
			};
		}),
	);
}

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { todaySnapshotSchema } from "@/summaries/snapshot";
import { answerToday } from "@/summaries/today";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * No input: which day "today" is follows from WHOOP, not from an argument — it
 * is the cycle currently running. Spelled as an empty `z.strictObject(...)` so
 * clients see a well-formed object schema in `tools/list` that takes no
 * properties at all, and an argument sent anyway is refused rather than quietly
 * dropped.
 */
const getTodaySnapshotInputSchema = z.strictObject({});

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
			const { snapshot, json } = await answerToday();

			return {
				content: [{ type: "text" as const, text: json }],
				structuredContent: snapshot,
			};
		}),
	);
}

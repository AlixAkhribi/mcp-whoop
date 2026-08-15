import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonToolResult } from "@/json";
import {
	readTodaySnapshot,
	todaySnapshotSchema,
} from "@/whoop/reads/today-snapshot";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getTodaySnapshotInputSchema = z.strictObject({});

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
		observedTool("get_today_snapshot", async (_input, ctx: ServerContext) => {
			const snapshot = await readTodaySnapshot({
				signal: ctx.mcpReq.signal,
			});

			return jsonToolResult(snapshot);
		}),
	);
}

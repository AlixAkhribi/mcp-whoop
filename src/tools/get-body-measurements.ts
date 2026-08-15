import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import { bodyMeasurementsSchema } from "@/whoop/api/data/body-measurements";
import { readBodyMeasurements } from "@/whoop/reads/body-measurements";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getBodyMeasurementsInputSchema = z.strictObject({});

export function registerGetBodyMeasurementsTool(server: McpServer): void {
	server.registerTool(
		"get_body_measurements",
		{
			title: "WHOOP body measurements",
			description:
				"Reads the WHOOP body measurements (height, weight, max heart rate) of the user this server is logged in as.",
			inputSchema: getBodyMeasurementsInputSchema,
			outputSchema: bodyMeasurementsSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool(
			"get_body_measurements",
			async (_input, ctx: ServerContext) => {
				const measurements = await readBodyMeasurements({
					signal: ctx.mcpReq.signal,
				});

				return jsonToolResult(measurements);
			},
		),
	);
}

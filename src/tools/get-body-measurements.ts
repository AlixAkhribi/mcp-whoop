import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { answerBodyMeasurements } from "@/answers/body-measurements";
import { bodyMeasurementSchema } from "@/api/data/body-measurements";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * No input: whose measurements are read follows from the stored login. Spelled
 * as an empty `z.strictObject(...)` so clients see a well-formed object schema
 * in `tools/list` that takes no properties at all, and an argument sent anyway
 * is refused rather than quietly dropped.
 */
const getBodyMeasurementsInputSchema = z.strictObject({});

/** Registers the `get_body_measurements` tool on a server instance. */
export function registerGetBodyMeasurementsTool(server: McpServer): void {
	server.registerTool(
		"get_body_measurements",
		{
			title: "WHOOP body measurements",
			description:
				"Reads the WHOOP body measurements (height, weight, max heart rate) of the user this server is logged in as.",
			inputSchema: getBodyMeasurementsInputSchema,
			outputSchema: bodyMeasurementSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_body_measurements", async () => {
			const { measurements, json } = await answerBodyMeasurements();

			return {
				content: [{ type: "text" as const, text: json }],
				structuredContent: measurements,
			};
		}),
	);
}

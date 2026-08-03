import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
	bodyMeasurementSchema,
	fetchBodyMeasurements,
} from "@/api/data/body-measurements";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { redactingErrors } from "@/lib/redaction";
import { requireStoredLogin } from "./stored-login";

/**
 * No input: whose measurements are read follows from the stored login. Spelled
 * as an empty `z.object(...)` so clients still see a well-formed object schema
 * in `tools/list`.
 */
const getBodyMeasurementsInputSchema = z.object({});

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
		},
		redactingErrors(async () => {
			const tokens = await requireStoredLogin();

			const measurements = await withValidAccessToken(tokens, (accessToken) =>
				fetchBodyMeasurements(accessToken),
			);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(measurements, null, "\t"),
					},
				],
				structuredContent: measurements,
			};
		}),
	);
}

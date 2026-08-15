import { z } from "zod";

import { bodyMeasurementsEndpoint } from "@/whoop/api/client/endpoints";
import { readWhoopJson } from "@/whoop/api/client/read";

/**
 * WHOOP's `GET /v2/user/measurement/body` payload, in WHOOP's own field names.
 * The upstream shape is mirrored verbatim into the tool's structured output,
 * so a model reading it can rely on WHOOP's public documentation.
 */
export const bodyMeasurementsSchema = z.object({
	height_meter: z.number(),
	weight_kilogram: z.number(),
	max_heart_rate: z.number(),
});

export type WhoopBodyMeasurements = z.infer<typeof bodyMeasurementsSchema>;

export function fetchBodyMeasurements(
	accessToken: string,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopBodyMeasurements> {
	return readWhoopJson({
		operation: "the body-measurement read",
		endpoint: bodyMeasurementsEndpoint(options.env),
		accessToken,
		schema: bodyMeasurementsSchema,
		...options,
	});
}

import { z } from "zod";

import { bodyMeasurementEndpoint } from "@/api/client/endpoints";
import { WhoopUnauthorizedError } from "@/api/client/errors";
import { classifiedWhoopFailure, whoopFetch } from "@/api/client/http";

/**
 * WHOOP's `GET /v2/user/measurement/body` payload, in WHOOP's own field names.
 * The upstream shape is mirrored verbatim into the tool's structured output,
 * so a model reading it can rely on WHOOP's public documentation.
 */
export const bodyMeasurementSchema = z.object({
	height_meter: z.number(),
	weight_kilogram: z.number(),
	max_heart_rate: z.number(),
});

export type WhoopBodyMeasurement = z.infer<typeof bodyMeasurementSchema>;

/** Reads the body measurements of the user the access token belongs to. */
export async function fetchBodyMeasurements(
	accessToken: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopBodyMeasurement> {
	const response = await whoopFetch(
		"the body-measurement read",
		bodyMeasurementEndpoint(env),
		{
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: "application/json",
			},
		},
	);
	if (response.status === 401) {
		throw new WhoopUnauthorizedError();
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the body-measurement read",
			response,
			await response.text(),
		);
	}

	const parsed = bodyMeasurementSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error(
			"WHOOP answered the body-measurement read with an unexpected body",
		);
	}

	return parsed.data;
}

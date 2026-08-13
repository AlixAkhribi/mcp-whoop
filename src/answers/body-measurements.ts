/**
 * @file The body measurements, read whole — the stored login, the WHOOP read it
 * authorizes, and the one rendering of what came back.
 *
 * It sits outside both surfaces because the two must not drift: the
 * `get_body_measurements` tool is what a model reaches for and the
 * `whoop://body-measurements` resource is what a user attaches, but they are
 * one question with one answer, and the JSON is rendered once — here — so the
 * text they hand over is byte-for-byte the same text.
 *
 * Beside the profile rather than in `summaries/`, for the same reason: heights,
 * weights and a maximum heart rate are mirrored from WHOOP, never digested from
 * a span of records.
 */

import {
	fetchBodyMeasurements,
	type WhoopBodyMeasurement,
} from "@/api/data/body-measurements";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireGrant } from "@/auth/tokens/granted-scopes";
import { requireStoredLogin } from "@/auth/tokens/stored-login";

/**
 * The scope an answer here is read with. It is named beside the read that needs
 * it because both surfaces gate on it — the tool a model reaches for and the
 * resource a user attaches — and a grant without it buys neither.
 */
export const BODY_MEASUREMENT_SCOPES = ["read:body_measurement"] as const;

/**
 * The measurements, answered once and readable two ways: the record itself for
 * a surface that carries structure, and the one canonical rendering of it for a
 * surface that carries text.
 */
export type BodyMeasurementsAnswer = {
	/**
	 * The measurements as WHOOP holds them, in the shape
	 * `bodyMeasurementSchema` fixes.
	 */
	readonly measurements: WhoopBodyMeasurement;
	/** Those measurements as JSON — the exact text every surface hands over. */
	readonly json: string;
};

/**
 * Reads the WHOOP body measurements of the user this server is logged in as, in
 * the form both the `get_body_measurements` tool and the
 * `whoop://body-measurements` resource answer with.
 */
export async function answerBodyMeasurements(
	signal?: AbortSignal,
): Promise<BodyMeasurementsAnswer> {
	const tokens = await requireStoredLogin();
	// Judged on the grant as it stands now, whichever surface asked: the login
	// can be redone mid-connection, and the answer belongs to the current one.
	requireGrant(tokens.scopes, ...BODY_MEASUREMENT_SCOPES);

	const measurements = await withValidAccessToken(tokens, (accessToken) =>
		fetchBodyMeasurements(accessToken, undefined, signal),
	);

	return { measurements, json: JSON.stringify(measurements, null, "\t") };
}

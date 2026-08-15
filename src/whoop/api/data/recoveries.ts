import { z } from "zod";

import {
	cycleRecoveryEndpoint,
	recoveryCollectionEndpoint,
} from "@/whoop/api/client/endpoints";
import {
	readWhoopJson,
	readWhoopJsonOrAbsent,
	type WhoopPageQuery,
} from "@/whoop/api/client/read";
import { whoopPageSchema, whoopScoreStateSchema } from "./common";

/**
 * WHOOP's v2 `Recovery` record, in WHOOP's own field names — keyed by the
 * cycle it scores and the sleep it was computed from. The upstream shape is
 * mirrored verbatim into the tool's structured output, so a model reading it
 * can rely on WHOOP's public documentation. WHOOP sends explicit nulls rather
 * than omitting fields (observed 2026-08-02): `score` is null until
 * `score_state` reaches `SCORED`, and the blood-oxygen and skin-temperature
 * readings are null on hardware that does not measure them.
 */
export const recoverySchema = z.object({
	cycle_id: z.number(),
	sleep_id: z.string(),
	user_id: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	score_state: whoopScoreStateSchema,
	score: z
		.object({
			user_calibrating: z.boolean(),
			recovery_score: z.number(),
			resting_heart_rate: z.number(),
			hrv_rmssd_milli: z.number(),
			spo2_percentage: z.number().nullish(),
			skin_temp_celsius: z.number().nullish(),
		})
		.nullish(),
});

export type WhoopRecovery = z.infer<typeof recoverySchema>;

/**
 * One page of WHOOP's paginated recovery collection: the records, plus the
 * token that reaches the page after them. The last page carries
 * `next_token: null` — an explicit null (observed 2026-08-02), not an absent
 * field.
 */
export const recoveryPageSchema = whoopPageSchema(recoverySchema);

type WhoopRecoveryPage = z.infer<typeof recoveryPageSchema>;

export function fetchRecoveryPage(
	accessToken: string,
	query: WhoopPageQuery = {},
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopRecoveryPage> {
	return readWhoopJson({
		operation: "the recoveries read",
		endpoint: recoveryCollectionEndpoint(options.env),
		accessToken,
		schema: recoveryPageSchema,
		query,
		...options,
	});
}

/**
 * Reads the recovery scored for one cycle, or nothing when WHOOP holds none.
 * WHOOP joins the two: the recovery is addressed by the cycle it scores, not by
 * an id of its own.
 *
 * For callers that speak for a whole day, an empty join is an answer about that
 * day — "no recovery yet" — rather than a failed read, so it comes back as
 * `null` instead of as an error.
 */
export function fetchCycleRecoveryOrAbsent(
	accessToken: string,
	cycleId: number,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopRecovery | null> {
	// A 404 is WHOOP's answer for a cycle it has scored no recovery for — the
	// same answer it gives for a cycle this user does not have.
	return readWhoopJsonOrAbsent({
		operation: "the cycle recovery read",
		endpoint: cycleRecoveryEndpoint(cycleId, options.env),
		accessToken,
		schema: recoverySchema,
		...options,
	});
}

/**
 * Reads the recovery scored for one cycle, for the user the access token
 * belongs to, insisting there be one.
 *
 * An empty join is said as the join's own outcome rather than a bare not-found,
 * so a model reads it as "nothing to read here yet" instead of "that id is
 * wrong".
 *
 * @throws When WHOOP has no recovery for that cycle.
 */
export async function fetchCycleRecovery(
	accessToken: string,
	cycleId: number,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopRecovery> {
	const recovery = await fetchCycleRecoveryOrAbsent(
		accessToken,
		cycleId,
		options,
	);
	if (recovery === null) {
		throw new Error(
			`No recovery was found for cycle ${cycleId} on WHOOP — that cycle has no recovery yet.`,
		);
	}

	return recovery;
}

import { z } from "zod";

import {
	cycleRecoveryEndpoint,
	recoveryCollectionEndpoint,
} from "@/api/client/endpoints";
import { WhoopUnauthorizedError } from "@/api/client/errors";
import { classifiedWhoopFailure, whoopFetch } from "@/api/client/http";

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
	score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
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
export const recoveryPageSchema = z.object({
	records: z.array(recoverySchema),
	next_token: z.string().nullish(),
});

export type WhoopRecoveryPage = z.infer<typeof recoveryPageSchema>;

/**
 * The query WHOOP's `GET /v2/recovery` documents, in its own parameter names:
 * `start`/`end` bound the range as ISO 8601 strings, `limit` caps the page, and
 * `nextToken` — the `next_token` of the previous page, camel-cased on the way in
 * per WHOOP's OpenAPI document — continues the collection.
 */
export type RecoveryPageQuery = {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
};

/** Reads one page of the recoveries of the user the access token belongs to. */
export async function fetchRecoveryPage(
	accessToken: string,
	query: RecoveryPageQuery = {},
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<WhoopRecoveryPage> {
	const endpoint = recoveryCollectionEndpoint(env);
	// Relayed verbatim, under WHOOP's own parameter names, so the arguments a
	// model reads in WHOOP's documentation are the ones that go over the wire.
	for (const [name, value] of Object.entries(query)) {
		if (value !== undefined) {
			endpoint.searchParams.set(name, String(value));
		}
	}

	const response = await whoopFetch("the recoveries read", endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
		},
		signal,
	});
	if (response.status === 401) {
		throw new WhoopUnauthorizedError();
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the recoveries read",
			response,
			await response.text(),
		);
	}

	const parsed = recoveryPageSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error(
			"WHOOP answered the recoveries read with an unexpected body",
		);
	}

	return parsed.data;
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
export async function fetchCycleRecoveryOrAbsent(
	accessToken: string,
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<WhoopRecovery | null> {
	const response = await whoopFetch(
		"the cycle recovery read",
		cycleRecoveryEndpoint(cycleId, env),
		{
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: "application/json",
			},
			signal,
		},
	);
	if (response.status === 401) {
		throw new WhoopUnauthorizedError();
	}
	// WHOOP's answer for a cycle it has scored no recovery for — the same answer
	// it gives for a cycle this user does not have.
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the cycle recovery read",
			response,
			await response.text(),
		);
	}

	const parsed = recoverySchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error(
			"WHOOP answered the cycle recovery read with an unexpected body",
		);
	}

	return parsed.data;
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
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopRecovery> {
	const recovery = await fetchCycleRecoveryOrAbsent(accessToken, cycleId, env);
	if (recovery === null) {
		throw new Error(
			`No recovery was found for cycle ${cycleId} on WHOOP — that cycle has no recovery yet.`,
		);
	}

	return recovery;
}

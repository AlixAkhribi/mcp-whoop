import { z } from "zod";

import {
	workoutCollectionEndpoint,
	workoutEndpoint,
} from "@/api/client/endpoints";
import { WhoopUnauthorizedError } from "@/api/client/errors";
import { classifiedWhoopFailure, whoopFetch } from "@/api/client/http";

/**
 * WHOOP's v2 `Workout` record, in WHOOP's own field names — an activity keyed
 * by the string id v2 gives it, named by the sport WHOOP recognised it as
 * (`sport_id: -1` is the plain "activity" everything unrecognised is filed
 * under). The upstream shape is mirrored verbatim into the tool's structured
 * output, so a model reading it can rely on WHOOP's public documentation.
 * WHOOP sends explicit nulls rather than omitting fields (observed
 * 2026-08-02): `v1_id` is null for records born on v2, `score` until
 * `score_state` reaches `SCORED`, and the distance and altitude readings for
 * sports that do not record them.
 */
export const workoutSchema = z.object({
	id: z.string(),
	v1_id: z.number().nullish(),
	user_id: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	start: z.string(),
	end: z.string(),
	timezone_offset: z.string(),
	sport_name: z.string(),
	sport_id: z.number().nullish(),
	score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
	score: z
		.object({
			strain: z.number(),
			average_heart_rate: z.number(),
			max_heart_rate: z.number(),
			kilojoule: z.number(),
			percent_recorded: z.number(),
			distance_meter: z.number().nullish(),
			altitude_gain_meter: z.number().nullish(),
			altitude_change_meter: z.number().nullish(),
			zone_durations: z.object({
				zone_zero_milli: z.number(),
				zone_one_milli: z.number(),
				zone_two_milli: z.number(),
				zone_three_milli: z.number(),
				zone_four_milli: z.number(),
				zone_five_milli: z.number(),
			}),
		})
		.nullish(),
});

export type WhoopWorkout = z.infer<typeof workoutSchema>;

/**
 * One page of WHOOP's paginated workout collection: the records, plus the
 * token that reaches the page after them. The last page carries
 * `next_token: null` — an explicit null (observed 2026-08-02), not an absent
 * field.
 */
export const workoutPageSchema = z.object({
	records: z.array(workoutSchema),
	next_token: z.string().nullish(),
});

export type WhoopWorkoutPage = z.infer<typeof workoutPageSchema>;

/**
 * The query WHOOP's `GET /v2/activity/workout` documents, in its own parameter
 * names: `start`/`end` bound the range as ISO 8601 strings, `limit` caps the
 * page, and `nextToken` — the `next_token` of the previous page, camel-cased on
 * the way in per WHOOP's OpenAPI document — continues the collection.
 */
export type WorkoutPageQuery = {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
};

/** Reads one page of the workouts of the user the access token belongs to. */
export async function fetchWorkoutPage(
	accessToken: string,
	query: WorkoutPageQuery = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopWorkoutPage> {
	const endpoint = workoutCollectionEndpoint(env);
	// Relayed verbatim, under WHOOP's own parameter names, so the arguments a
	// model reads in WHOOP's documentation are the ones that go over the wire.
	for (const [name, value] of Object.entries(query)) {
		if (value !== undefined) {
			endpoint.searchParams.set(name, String(value));
		}
	}

	const response = await whoopFetch("the workouts read", endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
		},
	});
	if (response.status === 401) {
		throw new WhoopUnauthorizedError();
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the workouts read",
			response,
			await response.text(),
		);
	}

	const parsed = workoutPageSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the workouts read with an unexpected body");
	}

	return parsed.data;
}

/** Reads one workout by id, for the user the access token belongs to. */
export async function fetchWorkout(
	accessToken: string,
	workoutId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopWorkout> {
	const response = await whoopFetch(
		"the workout read",
		workoutEndpoint(workoutId, env),
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
	// WHOOP's answer for an id this user has no workout for. Said plainly, naming
	// the id, and without offering a retry: the same request will keep 404ing.
	if (response.status === 404) {
		throw new Error(`Workout ${workoutId} was not found on WHOOP.`);
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the workout read",
			response,
			await response.text(),
		);
	}

	const parsed = workoutSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the workout read with an unexpected body");
	}

	return parsed.data;
}

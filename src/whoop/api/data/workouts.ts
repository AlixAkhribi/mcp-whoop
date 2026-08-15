import { z } from "zod";

import {
	workoutCollectionEndpoint,
	workoutEndpoint,
} from "@/whoop/api/client/endpoints";
import { readWhoopJson, type WhoopPageQuery } from "@/whoop/api/client/read";
import { whoopPageSchema, whoopScoreStateSchema } from "./common";

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
	score_state: whoopScoreStateSchema,
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
export const workoutPageSchema = whoopPageSchema(workoutSchema);

type WhoopWorkoutPage = z.infer<typeof workoutPageSchema>;

export function fetchWorkoutPage(
	accessToken: string,
	query: WhoopPageQuery = {},
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopWorkoutPage> {
	return readWhoopJson({
		operation: "the workouts read",
		endpoint: workoutCollectionEndpoint(options.env),
		accessToken,
		schema: workoutPageSchema,
		query,
		...options,
	});
}

export function fetchWorkout(
	accessToken: string,
	workoutId: string,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopWorkout> {
	return readWhoopJson({
		operation: "the workout read",
		endpoint: workoutEndpoint(workoutId, options.env),
		accessToken,
		schema: workoutSchema,
		...options,
		// WHOOP's answer for an id this user has no workout for. Said plainly,
		// naming the id, and without offering a retry: the same request will
		// keep 404ing.
		notFound: () => new Error(`Workout ${workoutId} was not found on WHOOP.`),
	});
}

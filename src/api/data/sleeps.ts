import { z } from "zod";

import {
	cycleSleepEndpoint,
	sleepCollectionEndpoint,
	sleepEndpoint,
} from "@/api/client/endpoints";
import { WhoopUnauthorizedError } from "@/api/client/errors";
import { classifiedWhoopFailure, whoopFetch } from "@/api/client/http";

/**
 * WHOOP's v2 `Sleep` record, in WHOOP's own field names — a night or, when
 * `nap` is set, a nap, keyed by the string id v2 gives it. `cycle_id` is the
 * join back to the physiological cycle the sleep belongs to, so a model holding
 * a sleep can read that cycle's strain or recovery without re-deriving the
 * cycle by date. The upstream shape is mirrored verbatim into the tool's
 * structured output, so a model reading it can rely on WHOOP's public
 * documentation. WHOOP sends explicit nulls rather than omitting fields
 * (observed 2026-08-02): `v1_id` is null for records born on v2, `score` until
 * `score_state` reaches `SCORED`, and the performance, consistency and
 * efficiency percentages until WHOOP has enough data to compute them.
 *
 * A scored sleep promises only its sleep-needed and stage-summary blocks. The
 * respiratory rate is as optional as those percentages — a night WHOOP measured
 * no breathing on can carry it as null or not carry it at all — so it is read
 * the same forgiving way rather than insisted upon.
 *
 * WHOOP documents `cycle_id` as required, and it is read as nullish anyway on
 * purpose: one record that broke that promise would otherwise fail the parse
 * around it and take the whole call — a page of sleeps, a snapshot of the day —
 * down with it, saying only that WHOOP answered with an unexpected body.
 */
export const sleepSchema = z.object({
	id: z.string(),
	cycle_id: z.number().nullish(),
	v1_id: z.number().nullish(),
	user_id: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	start: z.string(),
	end: z.string(),
	timezone_offset: z.string(),
	nap: z.boolean(),
	score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
	score: z
		.object({
			stage_summary: z.object({
				total_in_bed_time_milli: z.number(),
				total_awake_time_milli: z.number(),
				total_no_data_time_milli: z.number(),
				total_light_sleep_time_milli: z.number(),
				total_slow_wave_sleep_time_milli: z.number(),
				total_rem_sleep_time_milli: z.number(),
				sleep_cycle_count: z.number(),
				disturbance_count: z.number(),
			}),
			sleep_needed: z.object({
				baseline_milli: z.number(),
				need_from_sleep_debt_milli: z.number(),
				need_from_recent_strain_milli: z.number(),
				need_from_recent_nap_milli: z.number(),
			}),
			respiratory_rate: z.number().nullish(),
			sleep_performance_percentage: z.number().nullish(),
			sleep_consistency_percentage: z.number().nullish(),
			sleep_efficiency_percentage: z.number().nullish(),
		})
		.nullish(),
});

export type WhoopSleep = z.infer<typeof sleepSchema>;

/**
 * One page of WHOOP's paginated sleep collection: the records, plus the token
 * that reaches the page after them. The last page carries `next_token: null` —
 * an explicit null (observed 2026-08-02), not an absent field.
 */
export const sleepPageSchema = z.object({
	records: z.array(sleepSchema),
	next_token: z.string().nullish(),
});

export type WhoopSleepPage = z.infer<typeof sleepPageSchema>;

/**
 * The query WHOOP's `GET /v2/activity/sleep` documents, in its own parameter
 * names: `start`/`end` bound the range as ISO 8601 strings, `limit` caps the
 * page, and `nextToken` — the `next_token` of the previous page, camel-cased on
 * the way in per WHOOP's OpenAPI document — continues the collection.
 */
export type SleepPageQuery = {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
};

/** Reads one page of the sleeps of the user the access token belongs to. */
export async function fetchSleepPage(
	accessToken: string,
	query: SleepPageQuery = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopSleepPage> {
	const endpoint = sleepCollectionEndpoint(env);
	// Relayed verbatim, under WHOOP's own parameter names, so the arguments a
	// model reads in WHOOP's documentation are the ones that go over the wire.
	for (const [name, value] of Object.entries(query)) {
		if (value !== undefined) {
			endpoint.searchParams.set(name, String(value));
		}
	}

	const response = await whoopFetch("the sleeps read", endpoint, {
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
			"the sleeps read",
			response,
			await response.text(),
		);
	}

	const parsed = sleepPageSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the sleeps read with an unexpected body");
	}

	return parsed.data;
}

/** Reads one sleep by id, for the user the access token belongs to. */
export async function fetchSleep(
	accessToken: string,
	sleepId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopSleep> {
	const response = await whoopFetch(
		"the sleep read",
		sleepEndpoint(sleepId, env),
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
	// WHOOP's answer for an id this user has no sleep for. Said plainly, naming
	// the id, and without offering a retry: the same request will keep 404ing.
	if (response.status === 404) {
		throw new Error(`Sleep ${sleepId} was not found on WHOOP.`);
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the sleep read",
			response,
			await response.text(),
		);
	}

	const parsed = sleepSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the sleep read with an unexpected body");
	}

	return parsed.data;
}

/**
 * Reads the sleep that started one cycle, or nothing when WHOOP holds none.
 * WHOOP joins the two: the sleep is addressed by the cycle it begins, not by an
 * id of its own.
 *
 * For callers that speak for a whole day, an empty join is an answer about that
 * day — "no sleep recorded" — rather than a failed read, so it comes back as
 * `null` instead of as an error.
 */
export async function fetchCycleSleepOrAbsent(
	accessToken: string,
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopSleep | null> {
	const response = await whoopFetch(
		"the cycle sleep read",
		cycleSleepEndpoint(cycleId, env),
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
	// WHOOP's answer for a cycle it has recorded no sleep for — the same answer
	// it gives for a cycle this user does not have.
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the cycle sleep read",
			response,
			await response.text(),
		);
	}

	const parsed = sleepSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error(
			"WHOOP answered the cycle sleep read with an unexpected body",
		);
	}

	return parsed.data;
}

/**
 * Reads the sleep that started one cycle, for the user the access token belongs
 * to, insisting there be one.
 *
 * An empty join is said as the join's own outcome rather than a bare not-found,
 * so a model reads it as "nothing to read here yet" instead of "that id is
 * wrong".
 *
 * @throws When WHOOP has no sleep for that cycle.
 */
export async function fetchCycleSleep(
	accessToken: string,
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopSleep> {
	const sleep = await fetchCycleSleepOrAbsent(accessToken, cycleId, env);
	if (sleep === null) {
		throw new Error(
			`No sleep was found for cycle ${cycleId} on WHOOP — that cycle has no sleep yet.`,
		);
	}

	return sleep;
}

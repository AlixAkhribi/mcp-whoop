import { z } from "zod";

import { cycleCollectionEndpoint, cycleEndpoint } from "@/api/client/endpoints";
import { WhoopUnauthorizedError } from "@/api/client/errors";
import { classifiedWhoopFailure, whoopFetch } from "@/api/client/http";

/**
 * WHOOP's v2 `Cycle` record, in WHOOP's own field names. The upstream shape is
 * mirrored verbatim into the tool's structured output, so a model reading it
 * can rely on WHOOP's public documentation. WHOOP sends explicit nulls rather
 * than omitting fields (observed 2026-08-02): `end` is null while the cycle is
 * still open, and `score` until `score_state` reaches `SCORED`.
 */
export const cycleSchema = z.object({
	id: z.number(),
	user_id: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	start: z.string(),
	end: z.string().nullish(),
	timezone_offset: z.string(),
	score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
	score: z
		.object({
			strain: z.number(),
			kilojoule: z.number(),
			average_heart_rate: z.number(),
			max_heart_rate: z.number(),
		})
		.nullish(),
});

export type WhoopCycle = z.infer<typeof cycleSchema>;

/**
 * One page of WHOOP's paginated cycle collection: the records, plus the token
 * that reaches the page after them. The last page carries `next_token: null` —
 * an explicit null (observed 2026-08-02), not an absent field.
 */
export const cyclePageSchema = z.object({
	records: z.array(cycleSchema),
	next_token: z.string().nullish(),
});

export type WhoopCyclePage = z.infer<typeof cyclePageSchema>;

/**
 * The query WHOOP's `GET /v2/cycle` documents, in its own parameter names:
 * `start`/`end` bound the range as ISO 8601 strings, `limit` caps the page, and
 * `nextToken` — the `next_token` of the previous page, camel-cased on the way in
 * per WHOOP's OpenAPI document — continues the collection.
 */
export type CyclePageQuery = {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
};

/** Reads one page of the cycles of the user the access token belongs to. */
export async function fetchCyclePage(
	accessToken: string,
	query: CyclePageQuery = {},
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<WhoopCyclePage> {
	const endpoint = cycleCollectionEndpoint(env);
	// Relayed verbatim, under WHOOP's own parameter names, so the arguments a
	// model reads in WHOOP's documentation are the ones that go over the wire.
	for (const [name, value] of Object.entries(query)) {
		if (value !== undefined) {
			endpoint.searchParams.set(name, String(value));
		}
	}

	const response = await whoopFetch("the cycles read", endpoint, {
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
			"the cycles read",
			response,
			await response.text(),
		);
	}

	const parsed = cyclePageSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the cycles read with an unexpected body");
	}

	return parsed.data;
}

/** Reads one cycle by id, for the user the access token belongs to. */
export async function fetchCycle(
	accessToken: string,
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WhoopCycle> {
	const response = await whoopFetch(
		"the cycle read",
		cycleEndpoint(cycleId, env),
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
	// WHOOP's answer for an id this user has no cycle for. Said plainly, naming
	// the id, and without offering a retry: the same request will keep 404ing.
	if (response.status === 404) {
		throw new Error(`Cycle ${cycleId} was not found on WHOOP.`);
	}
	if (!response.ok) {
		throw classifiedWhoopFailure(
			"the cycle read",
			response,
			await response.text(),
		);
	}

	const parsed = cycleSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the cycle read with an unexpected body");
	}

	return parsed.data;
}

import { z } from "zod";

import {
	cycleCollectionEndpoint,
	cycleEndpoint,
} from "@/whoop/api/client/endpoints";
import { readWhoopJson, type WhoopPageQuery } from "@/whoop/api/client/read";
import { whoopPageSchema, whoopScoreStateSchema } from "./common";

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
	score_state: whoopScoreStateSchema,
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
export const cyclePageSchema = whoopPageSchema(cycleSchema);

type WhoopCyclePage = z.infer<typeof cyclePageSchema>;

export function fetchCyclePage(
	accessToken: string,
	query: WhoopPageQuery = {},
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopCyclePage> {
	return readWhoopJson({
		operation: "the cycles read",
		endpoint: cycleCollectionEndpoint(options.env),
		accessToken,
		schema: cyclePageSchema,
		query,
		...options,
	});
}

export function fetchCycle(
	accessToken: string,
	cycleId: number,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopCycle> {
	return readWhoopJson({
		operation: "the cycle read",
		endpoint: cycleEndpoint(cycleId, options.env),
		accessToken,
		schema: cycleSchema,
		...options,
		// WHOOP's answer for an id this user has no cycle for. Said plainly,
		// naming the id, and without offering a retry: the same request will
		// keep 404ing.
		notFound: () => new Error(`Cycle ${cycleId} was not found on WHOOP.`),
	});
}

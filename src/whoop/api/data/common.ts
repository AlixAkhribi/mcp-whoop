import { z } from "zod";

export const WHOOP_MAX_PAGE_SIZE = 25;

export const whoopScoreStateSchema = z.enum([
	"SCORED",
	"PENDING_SCORE",
	"UNSCORABLE",
]);

/** Keeps WHOOP's page envelope identical while records remain domain-specific. */
export function whoopPageSchema<T extends z.ZodType>(recordSchema: T) {
	return z.object({
		records: z.array(recordSchema),
		next_token: z.string().nullish(),
	});
}

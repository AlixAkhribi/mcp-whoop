import { z } from "zod";

import { profileEndpoint } from "@/whoop/api/client/endpoints";
import { readWhoopJson } from "@/whoop/api/client/read";

/**
 * WHOOP's `GET /v2/user/profile/basic` payload, in WHOOP's own field names.
 * The upstream shape is mirrored verbatim into the tool's structured output,
 * so a model reading it can rely on WHOOP's public documentation.
 */
export const profileSchema = z.object({
	user_id: z.number(),
	email: z.string(),
	first_name: z.string(),
	last_name: z.string(),
});

export type WhoopProfile = z.infer<typeof profileSchema>;

export function fetchProfile(
	accessToken: string,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<WhoopProfile> {
	return readWhoopJson({
		operation: "the profile read",
		endpoint: profileEndpoint(options.env),
		accessToken,
		schema: profileSchema,
		...options,
	});
}

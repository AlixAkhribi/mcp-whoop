import { z } from "zod";

import { profileEndpoint } from "@/api/client/endpoints";
import { WhoopUnauthorizedError } from "@/api/client/errors";
import { classifiedWhoopFailure, whoopFetch } from "@/api/client/http";

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

/** Reads the basic profile of the user the access token belongs to. */
export async function fetchProfile(
	accessToken: string,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<WhoopProfile> {
	const response = await whoopFetch("the profile read", profileEndpoint(env), {
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
			"the profile read",
			response,
			await response.text(),
		);
	}

	const parsed = profileSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success) {
		throw new Error("WHOOP answered the profile read with an unexpected body");
	}

	return parsed.data;
}

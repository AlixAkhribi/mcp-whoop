/**
 * @file The profile, read whole — the stored login, the WHOOP read it
 * authorizes, and the one rendering of what came back.
 *
 * It sits outside both surfaces because the two must not drift: the
 * `get_profile` tool is what a model reaches for and the `whoop://profile`
 * resource is what a user attaches, but they are one question with one answer,
 * and the JSON is rendered once — here — so the text they hand over is
 * byte-for-byte the same text.
 *
 * A directory of its own rather than a place in `summaries/`: a profile is
 * mirrored from WHOOP, never digested from a span of records, so nothing about
 * it belongs beside the things that compute a fixed-shape digest.
 */

import { fetchProfile, type WhoopProfile } from "@/api/data/profile";
import { withValidAccessToken } from "@/auth/tokens/authorized";
import { requireGrant } from "@/auth/tokens/granted-scopes";
import { requireStoredLogin } from "@/auth/tokens/stored-login";

/**
 * The scope an answer here is read with. It is named beside the read that needs
 * it because both surfaces gate on it — the tool a model reaches for and the
 * resource a user attaches — and a grant without it buys neither.
 */
export const PROFILE_SCOPES = ["read:profile"] as const;

/**
 * The profile, answered once and readable two ways: the record itself for a
 * surface that carries structure, and the one canonical rendering of it for a
 * surface that carries text.
 */
export type ProfileAnswer = {
	/** The profile as WHOOP holds it, in the shape `profileSchema` fixes. */
	readonly profile: WhoopProfile;
	/** That profile as JSON — the exact text every surface hands over. */
	readonly json: string;
};

/**
 * Reads the WHOOP profile of the user this server is logged in as, in the form
 * both the `get_profile` tool and the `whoop://profile` resource answer with.
 */
export async function answerProfile(
	signal?: AbortSignal,
): Promise<ProfileAnswer> {
	const tokens = await requireStoredLogin();
	// Judged on the grant as it stands now, whichever surface asked: the login
	// can be redone mid-connection, and the answer belongs to the current one.
	requireGrant(tokens.scopes, ...PROFILE_SCOPES);

	const profile = await withValidAccessToken(tokens, (accessToken) =>
		fetchProfile(accessToken, undefined, signal),
	);

	return { profile, json: JSON.stringify(profile, null, "\t") };
}

import { fetchProfile, type WhoopProfile } from "@/whoop/api/data/profile";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { PROFILE_SCOPES } from "@/whoop/auth/tokens/scopes";

/** Reads the current login's WHOOP profile. */
export async function readProfile({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<WhoopProfile> {
	return withAuthorizedWhoopAccess(
		PROFILE_SCOPES,
		({ accessToken, signal: requestSignal }) =>
			fetchProfile(accessToken, { signal: requestSignal }),
		{ signal },
	);
}

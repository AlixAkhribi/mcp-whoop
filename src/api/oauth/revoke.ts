import { revokeAccessEndpoint } from "@/api/client/endpoints";

/**
 * Asks WHOOP to revoke the access the given token carries, by DELETEing
 * `/v2/user/access` as the documented revocation call.
 *
 * Reports whether WHOOP confirmed rather than throwing: an error response and
 * an unreachable WHOOP both leave the grant possibly alive, and the caller has
 * to forget the tokens locally either way.
 */
export async function revokeAccess(
	accessToken: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ confirmed: boolean }> {
	try {
		const response = await fetch(revokeAccessEndpoint(env), {
			method: "DELETE",
			headers: { authorization: `Bearer ${accessToken}` },
		});

		return { confirmed: response.ok };
	} catch {
		return { confirmed: false };
	}
}

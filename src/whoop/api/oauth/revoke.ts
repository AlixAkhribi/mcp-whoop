import { registerSecrets } from "@/lib/redaction";
import { revokeAccessEndpoint } from "@/whoop/api/client/endpoints";
import { whoopFetch } from "@/whoop/api/client/http";

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
	{ env = process.env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ confirmed: boolean }> {
	try {
		registerSecrets(accessToken);
		const response = await whoopFetch({
			operation: "the access revocation",
			url: revokeAccessEndpoint(env),
			env,
			method: "DELETE",
			headers: { authorization: `Bearer ${accessToken}` },
		});

		return { confirmed: response.ok };
	} catch {
		return { confirmed: false };
	}
}

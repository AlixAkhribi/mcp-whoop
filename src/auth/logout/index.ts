import { revokeAccess } from "@/api/oauth/revoke";
import { refreshTokens } from "@/api/oauth/token-refresh";
import {
	deleteStoredTokens,
	readStoredTokens,
	type StoredTokens,
} from "@/auth/tokens/store";

/**
 * The parts of the logout command a terminal normally owns. Both default to
 * the real thing; passing explicit ones keeps a run from writing to the console.
 */
export type LogoutRuntime = {
	/** Environment the WHOOP base URL and the store location come from. */
	readonly env?: NodeJS.ProcessEnv;
	/** Where the command's own output goes. */
	readonly print?: (message: string) => void;
};

/**
 * The freshest access token this logout can put behind the revocation.
 *
 * A WHOOP access token lasts about an hour, so a logout run any later than the
 * last refresh would hand WHOOP a bearer it has already forgotten and hear
 * nothing back but a refusal. One refresh first buys a token WHOOP still knows,
 * which is what makes the revocation land. Anything that goes wrong on the way
 * — no application to sign the grant with, a refresh token WHOOP no longer
 * honors, an unreachable WHOOP — leaves the stored token as the best one held,
 * because an unlikely revocation still beats none.
 *
 * The rotated pair is deliberately neither locked nor written back. The user
 * asked for this login to stop existing, so the one outcome that must be
 * impossible is a *live* login left on disk — which is exactly what a crash
 * between persisting and deleting would leave. Not persisting can only strand
 * dead material: a refresh token already spent, which the next use reports as a
 * login no longer valid. Skipping the store lock follows from the same
 * priority, since a lock some other process wedged must never hold a logout up.
 */
async function revocableAccessToken(
	tokens: StoredTokens,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	if (tokens.expiresAt > Date.now()) {
		return tokens.accessToken;
	}

	try {
		return (await refreshTokens(tokens, env)).accessToken;
	} catch {
		return tokens.accessToken;
	}
}

/**
 * Runs the `logout` command and reports the exit code it earned: asks WHOOP to
 * revoke the stored access server-side, then forgets it locally.
 */
export async function runLogout({
	env = process.env,
	print = (message) => {
		console.log(message);
	},
}: LogoutRuntime = {}): Promise<number> {
	const tokens = await readStoredTokens({ env });
	if (!tokens) {
		print("Not logged in to WHOOP: there is nothing to log out.");

		return 0;
	}

	const { confirmed } = await revokeAccess(
		await revocableAccessToken(tokens, env),
		env,
	);
	await deleteStoredTokens({ env });

	if (confirmed) {
		print("Logged out of WHOOP: access revoked and the stored login deleted.");
	} else {
		print("Logged out of WHOOP: the stored login is deleted.");
		print(
			"Warning: WHOOP did not confirm revoking this server's access, so it may still be granted upstream. You can revoke it yourself in the WHOOP app under App Permissions.",
		);
	}

	return 0;
}

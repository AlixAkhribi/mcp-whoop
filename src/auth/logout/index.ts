import { revokeAccess } from "@/api/oauth/revoke";
import { deleteStoredTokens, readStoredTokens } from "@/auth/tokens/store";

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

	const { confirmed } = await revokeAccess(tokens.accessToken, env);
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

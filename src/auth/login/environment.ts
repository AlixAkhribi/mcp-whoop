import { registerSecrets } from "@/lib/redaction";

/**
 * The credentials a WHOOP app supplies through the environment. Every user
 * registers their own application in WHOOP's Developer Dashboard, so these are
 * the user's to provide and there is nothing to fall back to.
 */
export const CREDENTIAL_VARIABLES = [
	"WHOOP_CLIENT_ID",
	"WHOOP_CLIENT_SECRET",
	"WHOOP_REDIRECT_URI",
] as const;

/** One of the environment variables a WHOOP app is configured through. */
export type CredentialVariable = (typeof CREDENTIAL_VARIABLES)[number];

/**
 * Which credentials the given environment does not supply, in the order above.
 * Blank counts as missing: an exported-but-empty variable is a configuration
 * mistake, not a value.
 */
export function missingCredentialVariables(
	env: NodeJS.ProcessEnv,
): CredentialVariable[] {
	return CREDENTIAL_VARIABLES.filter((name) => !env[name]?.trim());
}

/** The WHOOP application this server acts as, as the environment describes it. */
export type WhoopAppCredentials = {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
};

/**
 * The application the environment describes, or undefined when it does not
 * describe a whole one — the caller reports which parts are missing with
 * {@link missingCredentialVariables}.
 */
export function readCredentials(
	env: NodeJS.ProcessEnv,
): WhoopAppCredentials | undefined {
	const clientId = env.WHOOP_CLIENT_ID?.trim();
	const clientSecret = env.WHOOP_CLIENT_SECRET?.trim();
	const redirectUri = env.WHOOP_REDIRECT_URI?.trim();

	if (!(clientId && clientSecret && redirectUri)) {
		return undefined;
	}
	// The client secret enters the process here, and must never surface.
	registerSecrets(clientSecret);

	return { clientId, clientSecret, redirectUri };
}

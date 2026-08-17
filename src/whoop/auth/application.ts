/**
 * @file Resolves which WHOOP application this process acts as, from the
 * environment and the application a login recorded beside the tokens. The
 * single home of ADR 0003's precedence rule, shared by token refresh and the
 * elicited login so the two cannot disagree.
 */

import { registerSecrets } from "@/lib/redaction";
import {
	CREDENTIAL_VARIABLES,
	type CredentialVariable,
} from "@/whoop/auth/login/credentials";
import type { StoredApplication } from "@/whoop/auth/tokens/store";

/**
 * The application this process acts as. The redirect URI is optional: a
 * refresh never sends one, and stores written before it was recorded name
 * none.
 */
export type ResolvedApplication = StoredApplication;

/**
 * The credential pair the environment describes, or undefined unless both
 * halves are present: half a pair from here and half from the store would
 * authenticate as neither application.
 */
function environmentPair(
	env: NodeJS.ProcessEnv,
): Pick<ResolvedApplication, "clientId" | "clientSecret"> | undefined {
	const clientId = env.WHOOP_CLIENT_ID?.trim();
	const clientSecret = env.WHOOP_CLIENT_SECRET?.trim();

	return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * The application to act as, or undefined when neither source supplies a
 * whole credential pair.
 *
 * A complete environment pair outranks the recorded one, so a secret rotated
 * in WHOOP's dashboard reaches stores that predate the rotation (ADR 0003); a
 * partial pair contributes nothing. The redirect URI resolves independently —
 * it is a callback address, not a credential — so an environment supplying
 * only a rotated pair keeps the redirect URI its login was granted at.
 */
export function resolveApplication(
	env: NodeJS.ProcessEnv,
	recorded: StoredApplication | undefined,
): ResolvedApplication | undefined {
	const pair = environmentPair(env) ?? recorded;
	if (!pair) {
		return undefined;
	}
	// The client secret enters this process here, from whichever source won.
	registerSecrets(pair.clientSecret);
	const redirectUri = env.WHOOP_REDIRECT_URI?.trim() || recorded?.redirectUri;

	return {
		clientId: pair.clientId,
		clientSecret: pair.clientSecret,
		...(redirectUri === undefined ? {} : { redirectUri }),
	};
}

/**
 * The credential variables that would supply what {@link resolveApplication}
 * could not, in declaration order.
 */
export function missingApplicationVariables(
	app: ResolvedApplication | undefined,
): CredentialVariable[] {
	const supplied: Record<CredentialVariable, boolean> = {
		WHOOP_CLIENT_ID: app !== undefined,
		WHOOP_CLIENT_SECRET: app !== undefined,
		WHOOP_REDIRECT_URI: app?.redirectUri !== undefined,
	};

	return CREDENTIAL_VARIABLES.filter((name) => !supplied[name]);
}

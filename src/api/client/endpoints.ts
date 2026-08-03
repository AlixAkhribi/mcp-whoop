/** WHOOP's API origin unless `WHOOP_API_BASE_URL` points elsewhere. */
export const DEFAULT_API_BASE_URL = "https://api.prod.whoop.com";

/**
 * The origin every WHOOP request goes to, authorization and data alike, so a
 * proxy or test double can redirect all of them at once. Trailing slashes are
 * stripped so the paths below join cleanly.
 */
export function whoopApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.WHOOP_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_API_BASE_URL
	);
}

/** Where the user grants or refuses this application consent. */
export function authorizeEndpoint(env: NodeJS.ProcessEnv = process.env): URL {
	return new URL(`${whoopApiBaseUrl(env)}/oauth/oauth2/auth`);
}

/** Where an authorization code is traded for tokens. */
export function tokenEndpoint(env: NodeJS.ProcessEnv = process.env): URL {
	return new URL(`${whoopApiBaseUrl(env)}/oauth/oauth2/token`);
}

/**
 * Where the logged-in user's basic profile is read. Data endpoints sit under
 * `/developer` where the OAuth ones do not; WHOOP answers 404 without it.
 */
export function profileEndpoint(env: NodeJS.ProcessEnv = process.env): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/user/profile/basic`);
}

/** Where the logged-in user's body measurements are read. */
export function bodyMeasurementEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/user/measurement/body`);
}

/** Where a login's granted access is revoked, by DELETEing it. */
export function revokeAccessEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/user/access`);
}

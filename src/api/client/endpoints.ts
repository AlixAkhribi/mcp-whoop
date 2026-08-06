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

/** Where the logged-in user's physiological cycles are listed, paginated. */
export function cycleCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/cycle`);
}

/** Where one physiological cycle is read by its id. */
export function cycleEndpoint(
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/cycle/${cycleId}`);
}

/** Where the recovery scored for one physiological cycle is read. */
export function cycleRecoveryEndpoint(
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(
		`${whoopApiBaseUrl(env)}/developer/v2/cycle/${cycleId}/recovery`,
	);
}

/** Where the sleep that started one physiological cycle is read. */
export function cycleSleepEndpoint(
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/cycle/${cycleId}/sleep`);
}

/** Where the logged-in user's sleeps are listed, paginated. */
export function sleepCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/activity/sleep`);
}

/** Where one sleep is read by its id. */
export function sleepEndpoint(
	sleepId: string,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(
		`${whoopApiBaseUrl(env)}/developer/v2/activity/sleep/${sleepId}`,
	);
}

/** Where the logged-in user's workouts are listed, paginated. */
export function workoutCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/activity/workout`);
}

/** Where one workout is read by its id. */
export function workoutEndpoint(
	workoutId: string,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(
		`${whoopApiBaseUrl(env)}/developer/v2/activity/workout/${workoutId}`,
	);
}

/** Where the logged-in user's recoveries are listed, paginated. */
export function recoveryCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/recovery`);
}

/** Where a login's granted access is revoked, by DELETEing it. */
export function revokeAccessEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/user/access`);
}

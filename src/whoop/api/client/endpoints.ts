const DEFAULT_API_BASE_URL = "https://api.prod.whoop.com";

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

export function authorizeEndpoint(env: NodeJS.ProcessEnv = process.env): URL {
	return new URL(`${whoopApiBaseUrl(env)}/oauth/oauth2/auth`);
}

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

export function bodyMeasurementsEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/user/measurement/body`);
}

export function cycleCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/cycle`);
}

export function cycleEndpoint(
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/cycle/${cycleId}`);
}

export function cycleRecoveryEndpoint(
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(
		`${whoopApiBaseUrl(env)}/developer/v2/cycle/${cycleId}/recovery`,
	);
}

export function cycleSleepEndpoint(
	cycleId: number,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/cycle/${cycleId}/sleep`);
}

export function sleepCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/activity/sleep`);
}

export function sleepEndpoint(
	sleepId: string,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(
		`${whoopApiBaseUrl(env)}/developer/v2/activity/sleep/${sleepId}`,
	);
}

export function workoutCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/activity/workout`);
}

export function workoutEndpoint(
	workoutId: string,
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(
		`${whoopApiBaseUrl(env)}/developer/v2/activity/workout/${workoutId}`,
	);
}

export function recoveryCollectionEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/recovery`);
}

export function revokeAccessEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): URL {
	return new URL(`${whoopApiBaseUrl(env)}/developer/v2/user/access`);
}

/**
 * Every read scope WHOOP defines. Asking for all of them by default is what
 * makes a first login enough for the whole server: a scope not granted at login
 * can only be added by logging in again.
 */
export const DEFAULT_READ_SCOPES = [
	"read:profile",
	"read:body_measurement",
	"read:cycles",
	"read:sleep",
	"read:recovery",
	"read:workout",
] as const;

/**
 * The scope that makes WHOOP issue a refresh token. Without it the login would
 * die with the first access token, so it is appended whatever else is asked for.
 */
export const OFFLINE_SCOPE = "offline";

/**
 * The scopes this login asks WHOOP for: every read scope, or just the ones
 * `WHOOP_SCOPES` names for a user who wants this server to see less. Either way
 * `offline` comes along.
 */
export function requestedScopes(env: NodeJS.ProcessEnv): string[] {
	const narrowed = env.WHOOP_SCOPES?.trim();
	const requested = narrowed
		? narrowed.split(/[\s,]+/).filter(Boolean)
		: [...DEFAULT_READ_SCOPES];

	return requested.includes(OFFLINE_SCOPE)
		? requested
		: [...requested, OFFLINE_SCOPE];
}

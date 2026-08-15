import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";

/**
 * How `WHOOP_SCOPES` names several scopes: separated by commas, whitespace,
 * or any mix of the two. The startup validation reads the variable with the
 * same grammar (`src/config/environment.ts`), so what it accepts is exactly
 * what a login asks for.
 */
export function splitScopes(list: string): string[] {
	return list.split(/[\s,]+/).filter(Boolean);
}

/**
 * The scopes this login asks WHOOP for: every read scope, or just the ones
 * `WHOOP_SCOPES` names for a user who wants this server to see less. Either way
 * `offline` comes along.
 */
export function requestedScopes(env: NodeJS.ProcessEnv): string[] {
	const narrowed = env.WHOOP_SCOPES?.trim();
	const requested = narrowed ? splitScopes(narrowed) : [...DEFAULT_READ_SCOPES];

	return requested.includes(OFFLINE_SCOPE)
		? requested
		: [...requested, OFFLINE_SCOPE];
}

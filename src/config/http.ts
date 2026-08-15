/** Default bound for every request made to WHOOP. */
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Node's maximum reliable timer delay. */
export const MAX_HTTP_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolves the WHOOP request bound from the same environment as the endpoint.
 * Startup rejects malformed values; the fallback keeps direct callers safe.
 */
export function whoopRequestTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const configured = Number(env.WHOOP_HTTP_TIMEOUT_MS);

	return Number.isInteger(configured) &&
		configured >= 1 &&
		configured <= MAX_HTTP_TIMEOUT_MS
		? configured
		: DEFAULT_HTTP_TIMEOUT_MS;
}

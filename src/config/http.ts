import { MAX_TIMER_MS } from "@/config/timers";

/** Default bound for every request made to WHOOP. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

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
		configured <= MAX_TIMER_MS
		? configured
		: DEFAULT_HTTP_TIMEOUT_MS;
}

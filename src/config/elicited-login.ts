/**
 * @file Timing settings for logins offered inside a conversation. Validated
 * at startup (`src/config/environment.ts`); the readers here fall back to the
 * defaults rather than trusting a value the gate would have refused.
 */

import { MAX_TIMER_MS } from "@/config/timers";

/**
 * How long a retry blocks waiting for WHOOP's redirect before answering
 * "still in progress": long enough for consent already given to land, short
 * enough not to leave a host's spinner hanging.
 */
export const DEFAULT_LOGIN_WAIT_MS = 2_000;

/** How long an unanswered attempt keeps the loopback port it borrowed. */
export const DEFAULT_LOGIN_TTL_MS = 600_000;

/**
 * The configured value when it is a valid timer duration, else the fallback —
 * blank, absent, and out-of-range values all read as unset.
 */
function timerMs(configured: string | undefined, fallback: number): number {
	const wanted = Number(configured);

	return Number.isInteger(wanted) && wanted >= 1 && wanted <= MAX_TIMER_MS
		? wanted
		: fallback;
}

/** How long a retry waits for the browser before answering "still in progress". */
export function loginWaitMs(env: NodeJS.ProcessEnv = process.env): number {
	return timerMs(env.WHOOP_LOGIN_WAIT_MS, DEFAULT_LOGIN_WAIT_MS);
}

/** How long an unanswered attempt is kept before it is ended. */
export function loginAttemptLifetimeMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return timerMs(env.WHOOP_LOGIN_TTL_MS, DEFAULT_LOGIN_TTL_MS);
}

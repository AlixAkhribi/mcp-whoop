/**
 * Node's maximum reliable timer delay, the shared ceiling for every
 * millisecond setting: above it `AbortSignal.timeout` throws and `setTimeout`
 * silently collapses to a 1 ms timer.
 */
export const MAX_TIMER_MS = 2_147_483_647;

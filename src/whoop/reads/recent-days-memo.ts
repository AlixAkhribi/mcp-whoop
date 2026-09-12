/**
 * @file The in-process memo the `{date}` completion answers from: the recent
 * wake days one listing established, remembered briefly so the consecutive
 * completions of one conversation ask WHOOP once while a user types; concurrent
 * misses under that token share the listing already in flight. Keyed by the
 * access token they were read under — a different token in the store is a
 * different grant, possibly a different account, whose days the last listing
 * says nothing about. A day read never consults this memo: a read promises a
 * zero lifetime and is always fresh. Each serving process has its own memo,
 * which is what a stdio server is.
 */

/**
 * How long one listing keeps answering completions: about a minute — the pace
 * of typing a date, not the pace of living one. Long enough that every
 * keystroke of one completion does not relist, short enough that a day WHOOP
 * closes or rescores is offered by the next conversation.
 */
export const RECENT_DAYS_MEMO_LIFETIME_MS = 60_000;

/** One listing's answer, held beside the token and instant it started under. */
type RememberedListing = {
	readonly accessToken: string;
	readonly dates: readonly string[];
	readonly listedAt: number;
};

/** One listing still on its way back from WHOOP. */
type InFlightListing = {
	readonly accessToken: string;
	readonly promise: Promise<string[]>;
};

export type WakeDatesMemo = {
	/**
	 * Answers with the remembered dates when they were read under this very
	 * access token, or joins or runs `list` and remembers what it answered. A
	 * listing that refuses remembers nothing: only an answer is worth serving
	 * twice.
	 */
	serve(accessToken: string, list: () => Promise<string[]>): Promise<string[]>;
};

/**
 * A memo holding at most one remembered listing and one in-flight slot — one
 * store holds one login at a time. The clock is injectable so a unit can age a
 * memo without waiting a minute out; the serving process runs on the defaults.
 */
export function createWakeDatesMemo({
	lifetimeMs = RECENT_DAYS_MEMO_LIFETIME_MS,
	now = Date.now,
}: {
	lifetimeMs?: number;
	now?: () => number;
} = {}): WakeDatesMemo {
	let remembered: RememberedListing | undefined;
	let inFlight: InFlightListing | undefined;

	return {
		async serve(accessToken, list) {
			if (
				remembered !== undefined &&
				remembered.accessToken === accessToken &&
				// Aged from the listing that established it, not from the serve that
				// last read it: a stream of keystrokes must not keep a memo alive.
				now() - remembered.listedAt <= lifetimeMs
			) {
				// A copy, so no caller ever holds the remembered array itself.
				return [...remembered.dates];
			}
			if (inFlight?.accessToken === accessToken) {
				// A copy, so callers joining the same promise share no answer array.
				return [...(await inFlight.promise)];
			}
			const listedAt = now();
			const promise = list();
			inFlight = { accessToken, promise };
			try {
				const dates = await promise;
				remembered = { accessToken, dates, listedAt };

				return dates;
			} finally {
				// Another token may have put its own listing here while this one ran.
				if (inFlight?.promise === promise) {
					inFlight = undefined;
				}
			}
		},
	};
}

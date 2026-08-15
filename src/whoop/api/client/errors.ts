/**
 * WHOOP answered a data request with 401: the access token is no longer good,
 * whatever the store believed about its expiry. Thrown as its own class so the
 * authorized-call seam can tell "refresh and retry" apart from failures a new
 * token would not fix.
 */
export class WhoopUnauthorizedError extends Error {
	constructor() {
		super("WHOOP rejected the access token (HTTP 401)");
		this.name = "WhoopUnauthorizedError";
	}
}

/** WHOOP did not complete a request inside the configured transport bound. */
export class WhoopTimeoutError extends Error {
	constructor(operation: string) {
		super(
			`WHOOP timed out while handling ${operation}. It is safe to retry once the connection is healthy.`,
		);
		this.name = "WhoopTimeoutError";
	}
}

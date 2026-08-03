/**
 * WHOOP answered a data request with 401: the access token is no longer good,
 * whatever the store believed about its expiry. Thrown as its own class so the
 * authorized-call seam can tell "refresh and retry" apart from failures a new
 * token would not fix.
 */
export class WhoopUnauthorizedError extends Error {
	constructor() {
		super("WHOOP rejected the access token (HTTP 401)");
	}
}

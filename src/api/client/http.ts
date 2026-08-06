/**
 * @file Classifies failed WHOOP responses as retryable or fatal, in language a
 * model reading a tool error can act on. Rate limits and outages say "safe to
 * retry"; everything else says retrying will not help and carries an excerpt of
 * WHOOP's own message. 401s and by-id 404s stay with the callers, which treat
 * them as control flow rather than failures to relay.
 */

import { redactedExcerpt } from "@/lib/redaction";

/** How long a WHOOP request may go unanswered before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The bound every WHOOP request is given, in milliseconds.
 * `WHOOP_HTTP_TIMEOUT_MS` moves it — the same kind of environment seam
 * `WHOOP_API_BASE_URL` gives the origin (`src/api/client/endpoints.ts`), here so
 * a test can ask for a bound it can wait out. Anything but a positive, finite
 * number of milliseconds leaves the default standing.
 */
export function whoopRequestTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const configured = Number(env.WHOOP_HTTP_TIMEOUT_MS);

	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_TIMEOUT_MS;
}

/**
 * `fetch`, with a transport failure reported as such instead of surfacing as a
 * bare "fetch failed". No response means WHOOP never processed the request, so
 * it is always safe to send again.
 *
 * The request is bounded by {@link whoopRequestTimeoutMs}, so a WHOOP that
 * never answers ends the same way an unreachable one does rather than holding
 * a tool call open for as long as the runtime would allow. That bound is the
 * request's only `signal`: a caller handing one in has it replaced, so a caller
 * that needs to abort a WHOOP request for reasons of its own has to be given a
 * seam here rather than passing one through.
 */
export async function whoopFetch(
	what: string,
	url: URL,
	init?: RequestInit,
): Promise<Response> {
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(whoopRequestTimeoutMs()),
		});
	} catch {
		throw new Error(
			`WHOOP could not be reached for ${what}: a network failure, not a WHOOP answer. It is safe to retry once the connection is back.`,
		);
	}
}

/**
 * Whether a retry could plausibly get past this status: a rate limit, or an
 * outage on WHOOP's side. Callers that read meaning into specific 4xx bodies
 * must test this first — a rate-limited endpoint says nothing about its body.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * How long a rate-limited caller should wait, from whichever header WHOOP sent
 * it in. `Retry-After` is the HTTP standard one and is read first; WHOOP's own
 * rate-limiting documentation names `X-RateLimit-Reset` instead — the seconds
 * until the remaining-requests count resets, the same unit — so it stands in
 * whenever the standard header is absent or unreadable. A header naming no
 * number leaves the wait unsaid rather than quoted back at the caller.
 */
function retryAfterWait(headers: FailedAnswer["headers"]): string {
	for (const name of ["retry-after", "x-ratelimit-reset"]) {
		const header = headers.get(name);
		const seconds = Number(header);
		if (header && Number.isFinite(seconds) && seconds >= 0) {
			return `about ${Math.ceil(seconds)} seconds`;
		}
	}

	return "a short wait";
}

/** The part of a failed response the classifier reads. */
type FailedAnswer = {
	status: number;
	headers: { get(name: string): string | null };
};

/**
 * WHOOP's own description of a failure: `message` on the data endpoints,
 * `error_description` or `error` on the OAuth ones. Undefined when the body is
 * not JSON or names none of them.
 *
 * What comes back is an excerpt — scrubbed, then bounded — because the words
 * are WHOOP's to choose and this is where they enter a message of ours.
 */
function whoopMessageIn(body: string): string | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof payload !== "object" || payload === null) {
		return undefined;
	}

	for (const field of ["message", "error_description", "error"]) {
		const value = (payload as Record<string, unknown>)[field];
		if (typeof value === "string" && value.trim()) {
			return redactedExcerpt(value.trim());
		}
	}

	return undefined;
}

/**
 * Builds the error for a WHOOP response that is neither ok nor a 401. `what`
 * names the request as its caller refers to it — "the profile read", "the
 * token refresh" — so the message reads as a sentence.
 */
export function classifiedWhoopFailure(
	what: string,
	response: FailedAnswer,
	body: string,
): Error {
	if (response.status === 429) {
		return new Error(
			`WHOOP rate-limited ${what} (HTTP 429). It is safe to retry after ${retryAfterWait(
				response.headers,
			)}.`,
		);
	}

	if (response.status >= 500) {
		return new Error(
			`WHOOP is temporarily unavailable (HTTP ${response.status}): ${what} hit an outage on WHOOP's side. It is safe to retry shortly.`,
		);
	}

	const said = whoopMessageIn(body);

	return new Error(
		`WHOOP rejected ${what} (HTTP ${response.status})${
			said ? `: ${said}` : ""
		}. Retrying will not help.`,
	);
}

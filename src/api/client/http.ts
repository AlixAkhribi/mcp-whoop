/**
 * @file Classifies failed WHOOP responses as retryable or fatal, in language a
 * model reading a tool error can act on. Rate limits and outages say "safe to
 * retry"; everything else says retrying will not help and carries WHOOP's own
 * message. 401s and by-id 404s stay with the callers, which treat them as
 * control flow rather than failures to relay.
 */

/**
 * `fetch`, with a transport failure reported as such instead of surfacing as a
 * bare "fetch failed". No response means WHOOP never processed the request, so
 * it is always safe to send again.
 */
export async function whoopFetch(
	what: string,
	url: URL,
	init?: RequestInit,
): Promise<Response> {
	try {
		return await fetch(url, init);
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

/** How long a rate-limited caller should wait, from the Retry-After header. */
function retryAfterWait(header: string | null): string {
	const seconds = Number(header);
	if (header && Number.isFinite(seconds) && seconds >= 0) {
		return `about ${Math.ceil(seconds)} seconds`;
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
			return value.trim();
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
				response.headers.get("retry-after"),
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

/** What arriving at the redirect URI turned out to be. */
export type CapturedRedirect =
	| { readonly authorized: true; readonly code: string }
	| { readonly authorized: false; readonly failure: string };

/**
 * Classifies the query WHOOP sent the browser back with.
 *
 * An error is honoured before the state is checked, because WHOOP sends
 * pre-login refusals such as an over-asked scope back with an empty `state`;
 * gating errors on state would bury the actual refusal under a mismatch
 * report. A refusal carries no credentials, so relaying its words trusts the
 * redirect with nothing. The code path keeps the strict gate, since a code is
 * only evidence when it answers the request this login made.
 *
 * The same rules judge a redirect caught on a loopback port and one the user
 * pasted: how the query arrived says nothing about whether to trust it.
 */
export function classifyRedirect(
	query: URLSearchParams,
	expectedState: string,
): CapturedRedirect {
	const error = query.get("error");
	if (error) {
		// WHOOP's `error_description` is generic; the specific reason — "not
		// allowed to request scope X" — arrives in `error_hint`, so both are
		// relayed.
		const detail = [query.get("error_description"), query.get("error_hint")]
			.filter(Boolean)
			.join(" — ");

		return {
			authorized: false,
			failure: `WHOOP refused the authorization (${error}${detail ? `: ${detail}` : ""})`,
		};
	}

	if (query.get("state") !== expectedState) {
		return {
			authorized: false,
			failure:
				"the browser came back with a state this login never issued (state mismatch)",
		};
	}

	const code = query.get("code");

	return code
		? { authorized: true, code }
		: { authorized: false, failure: "the browser came back with no code" };
}

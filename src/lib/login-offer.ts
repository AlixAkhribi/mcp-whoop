/**
 * @file Wraps a served handler so a request with no usable WHOOP login answers
 * with a URL-mode elicitation carrying WHOOP's consent screen, instead of prose
 * telling the user to find a terminal.
 *
 * It sits in `lib/` beside the observed seam, and for the same reason: both
 * surfaces have to behave identically here. A tool call and a resource read
 * fail the same way when nothing is logged in, so one wrapper — and therefore
 * one policy about who may be offered a link, and when — governs both. Which
 * argument carries the request is the protocol library's business, not this
 * seam's, so the context is found among the arguments rather than assumed at a
 * position; a handler given none can be told nothing, and its failure stands.
 *
 * The offer is only made when the client can open URLs, this machine can
 * finish the login, and nobody has already declined one; otherwise the
 * original error stands. The wrapper must sit inside the observed seam:
 * `src/lib/observed.ts` rewrites thrown errors into plain `Error`s, so this
 * is the last place a login-shaped failure is still recognisable as one.
 */

import {
	CLIENT_CAPABILITIES_META_KEY,
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	type ServerContext,
} from "@modelcontextprotocol/server";

import { log } from "@/lib/log";
import {
	awaitLoginAttempt,
	endLoginAttempt,
	type LoginAttempt,
	startLoginAttempt,
} from "@/whoop/auth/elicited/attempt";
import { LoginRequiredError } from "@/whoop/auth/tokens/stored-login";

/**
 * The name of the one elicitation this server sends. Echoed back by the
 * client on retry, so it is part of the wire contract.
 */
const WHOOP_LOGIN = "whoop_login";

/** Shown beside the link, since the raw authorize URL reads as machinery. */
const CONSENT_MESSAGE =
	"Connect this server to WHOOP. The link opens WHOOP's own consent screen, where you sign in and approve read access to your WHOOP data. Nothing is shared until you approve it there.";

/** The one bit of a request's capability envelope this seam reads. */
type RequestCapabilities = {
	readonly elicitation?: { readonly url?: unknown };
};

/**
 * Whether this request's client declared URL-mode elicitation support.
 * Capabilities travel per request as of the 2026-07-28 revision. A bare
 * `elicitation: {}` means form mode only — never acceptable for credentials —
 * and a missing envelope means a pre-revision client, toward which the SDK's
 * legacy shim would push an `elicitation/create` that this check is the only
 * place to stop.
 */
function opensUrlElicitations(ctx: ServerContext): boolean {
	const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
	const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
		| RequestCapabilities
		| undefined;

	return capabilities?.elicitation?.url !== undefined;
}

/**
 * The unfinished answer offering WHOOP's consent screen. `requestState`
 * opaquely names the attempt now waiting on its loopback port; the token
 * store stays the ground truth on retry, so an altered value can at worst
 * name no attempt.
 */
function offerWhoopLogin(attempt: LoginAttempt): InputRequiredResult {
	log.info("no usable WHOOP login: offering this client a WHOOP consent link");

	return inputRequired({
		inputRequests: {
			[WHOOP_LOGIN]: inputRequired.elicitUrl({
				message: CONSENT_MESSAGE,
				url: attempt.authorizeUrl.href,
			}),
		},
		requestState: attempt.requestState,
	});
}

/**
 * The unfinished answer that says only "still in progress": the same attempt,
 * under the same name, with no input requests. The user is already at WHOOP's
 * consent screen, so no second link is put in front of them, and a round
 * asking for nothing needs no elicitation capability.
 */
function goOnWaiting(requestState: string): InputRequiredResult {
	log.debug(
		"WHOOP has not sent the browser back yet: asking for another round",
	);

	return inputRequired({ requestState });
}

/**
 * How a client says its user is not going to WHOOP. Either one ends the
 * attempt it answers, but only a decline — a decision, where a cancel is the
 * absence of one — suppresses future offers.
 */
type Refusal = "decline" | "cancel";

/**
 * The refusal this round carries, if any. An accept, or a round carrying no
 * answer at all, is none.
 */
function refusedConsent(ctx: ServerContext): Refusal | undefined {
	const answer = inputResponse(ctx.mcpReq.inputResponses, WHOOP_LOGIN);

	return answer.kind === "elicit" && answer.action !== "accept"
		? answer.action
		: undefined;
}

/** Whether a user of this process has already declined a consent link. */
let offersDeclined = false;

/**
 * Records the decline and logs it once. Deliberately never persisted: a
 * decline belongs to the conversation it was given in, so the next serving
 * process offers again rather than requiring a setting to undo.
 */
function rememberDecline(): void {
	if (offersDeclined) {
		return;
	}
	offersDeclined = true;
	log.info(
		"the WHOOP consent link was declined: this process offers no more consent links, and answers with the prose instead. Run `npx mcp-whoop login` in a terminal to log in — a serving process started later offers again.",
	);
}

/** What one run of the wrapped handler came to. */
type Handled<R> =
	| { readonly served: true; readonly result: R }
	| { readonly served: false; readonly loginRequired: LoginRequiredError };

/**
 * Runs the handler, catching only {@link LoginRequiredError}; anything else
 * is left to throw.
 */
async function handled<A extends unknown[], R>(
	handler: (...args: A) => Promise<R>,
	args: A,
): Promise<Handled<R>> {
	try {
		return { served: true, result: await handler(...args) };
	} catch (error) {
		if (!(error instanceof LoginRequiredError)) {
			throw error;
		}

		return { served: false, loginRequired: error };
	}
}

/**
 * Whether this argument is the request itself: recognised by the accessor
 * every served context carries, so a handler's own arguments cannot be
 * mistaken for one by having a field of the same name.
 */
function isRequestContext(argument: unknown): argument is ServerContext {
	return (
		typeof argument === "object" &&
		argument !== null &&
		"mcpReq" in argument &&
		typeof (argument as ServerContext).mcpReq?.requestState === "function"
	);
}

/**
 * The request these arguments were served for. The protocol library hands the
 * context to a tool as the second argument and to a resource read as the second
 * too, but a template read takes its variables in between — so it is found by
 * what it carries rather than by where it sits, and the last one wins, since
 * the request is always the final thing a handler is told about.
 */
function requestContextIn(args: readonly unknown[]): ServerContext | undefined {
	return args.filter(isRequestContext).at(-1);
}

/**
 * Wraps a served handler so a request with no usable login answers with a
 * consent-link elicitation instead of failing — a tool call and a resource
 * read alike. The handler runs first on every round, the retry included: the
 * token store is the only ground truth, and the login may have landed by any
 * route since the last read. A retry that arrives before WHOOP's redirect
 * waits briefly on the attempt it names; declining an attempt this process
 * offered suppresses further offers for the life of the process.
 *
 * A handler invoked with no request context among its arguments cannot be
 * offered anything — there is no client to ask and no round to carry an
 * answer — so its login failure stands as it did before.
 */
export function offeringWhoopLogin<A extends unknown[], R>(
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | InputRequiredResult> {
	return async (...args) => {
		const first = await handled(handler, args);
		const ctx = requestContextIn(args);
		if (!ctx) {
			if (first.served) {
				return first.result;
			}

			throw first.loginRequired;
		}
		const requestState = ctx.mcpReq.requestState<string>();
		if (first.served) {
			// A served retry still naming an attempt got its login by another
			// route; left running, the attempt's stale flow could land later and
			// overwrite the newer login this round just read.
			await endLoginAttempt(requestState);

			return first.result;
		}
		// Refusals are read only after the handler ran — a login the browser
		// finished is served whatever the client says about the link. A refusal
		// matters only when its state ends an attempt this process still holds: an
		// absent, altered, or stale name answers no elicitation of ours and decides
		// nothing about later offers.
		const refusal =
			typeof requestState === "string" && requestState !== ""
				? refusedConsent(ctx)
				: undefined;
		if (refusal) {
			const ended = await endLoginAttempt(requestState);
			if (ended) {
				log.info(
					"the WHOOP consent link was refused: ending the login attempt",
				);
				// Only a decline — a user's decision — suppresses future offers.
				if (refusal === "decline") {
					rememberDecline();
				}
			}

			throw first.loginRequired;
		}
		if (!opensUrlElicitations(ctx)) {
			throw first.loginRequired;
		}
		if (requestState !== undefined) {
			const attempt = await awaitLoginAttempt(requestState);
			if (attempt === "waiting") {
				return goOnWaiting(requestState);
			}
			// The attempt is over — or was never this process's. Either way the
			// store may say something different than it did a moment ago.
			const again = await handled(handler, args);
			if (again.served) {
				return again.result;
			}
		}
		// A decline withholds only the offer — every read above ran first, so a
		// login that landed by any other route is still served.
		if (offersDeclined) {
			throw first.loginRequired;
		}
		// The application and the redirect port are resolved before offering, so
		// a consent screen is only shown when consenting would finish the login.
		const started = await startLoginAttempt(process.env);
		if (!started.started) {
			throw new LoginRequiredError(started.unavailable);
		}

		return offerWhoopLogin(started.attempt);
	};
}

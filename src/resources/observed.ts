/**
 * @file The wrapper every resource read registers through: the same
 * redact-and-narrate seam the tools run inside (`src/lib/observed.ts`), phrased
 * for a resource — named on stderr by the URI the client asked to read, which
 * is what a reader of the log has in hand.
 *
 * A read has no `isError` result to fall back on the way a tool call does: the
 * SDK turns whatever a read callback throws straight into the JSON-RPC error,
 * message and all, so a read that skipped this seam would answer with whatever
 * words the failure happened to carry.
 */

import type { InputRequiredResult } from "@modelcontextprotocol/server";

import { offeringWhoopLogin } from "@/lib/login-offer";
import { observed } from "@/lib/observed";

/** Narrates one read on stderr under the URI it was asked for. */
function narrated<A extends unknown[], R>(
	uri: string,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return observed({ operation: uri, announce: `reading ${uri}` }, handler);
}

/**
 * Wraps a resource read handler with redaction and stderr narration: the read
 * at `debug`, a success at `info` with its duration, a failure at `error`
 * carrying the message the client will see — scrubbed once, logged and thrown
 * as the same string.
 *
 * A read that finds no usable WHOOP login answers with a consent link where the
 * client can show one — the very wrapper a tool call runs inside
 * (`src/lib/login-offer.ts`), so one policy decides who may be offered a login,
 * whichever surface asked.
 */
export function observedResource<A extends unknown[], R>(
	uri: string,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | InputRequiredResult> {
	return narrated(uri, offeringWhoopLogin(handler));
}

/**
 * Wraps a resource *template*'s read handler in the same seam, narrated by the
 * member URI the client actually asked for rather than by the pattern it
 * matched: a reader of the log has the URI in hand, and "reading
 * whoop://day/{date}" would name every day alike.
 *
 * The very consent-offer wrapper the fixed resources and the tools run inside
 * governs a member read too — one policy over every surface. It is handed the
 * handler whole rather than a closure over the read, because the offer is
 * judged from the request context the protocol library passes a template
 * handler after its variables; the wrapper finds it among the arguments by
 * what it carries, not by where it sits.
 */
export function observedTemplateResource<A extends unknown[], R>(
	handler: (uri: URL, ...rest: A) => Promise<R>,
): (uri: URL, ...rest: A) => Promise<R | InputRequiredResult> {
	const offering = offeringWhoopLogin(handler);

	return (uri, ...rest) => narrated(uri.href, offering)(uri, ...rest);
}

/**
 * Wraps a template variable's completer in the same seam, named by the
 * template: a completion belongs to the family, not to any member — no URI has
 * been filled in yet — so the pattern is the one name a reader of the log has
 * in hand. Announced, answered with a duration, failed with the scrubbed
 * message the client was refused with, exactly like a read.
 *
 * Narration and redaction are also the whole of what a completion can do about
 * failing: the 2026-07-28 revision allows an unfinished answer on tool calls,
 * resource reads and prompts only, so no consent link can be offered here — a
 * completion that cannot be answered refuses aloud, and the read that follows
 * makes the offer.
 */
export function observedCompleter<A extends unknown[], R>(
	uriTemplate: string,
	complete: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return observed(
		{ operation: uriTemplate, announce: `completing ${uriTemplate}` },
		complete,
	);
}

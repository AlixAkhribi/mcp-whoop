/**
 * @file The wrapper every tool handler registers through: the shared
 * redact-and-narrate seam (`src/lib/observed.ts`), phrased for a tool — named
 * on stderr by the name a model called it by — with the WHOOP login offer
 * inside it, where a login-shaped failure is still recognisable as one.
 */

import type {
	InputRequiredResult,
	ServerContext,
} from "@modelcontextprotocol/server";

import { offeringWhoopLogin } from "@/lib/login-offer";
import { observed } from "@/lib/observed";

/**
 * Wraps a tool handler with redaction and stderr narration: the call at
 * `debug`, a success at `info` with its duration, a failure at `error`
 * carrying the message the client will see — scrubbed once, logged and thrown
 * as the same string.
 *
 * A call that finds no usable WHOOP login answers with a consent link where
 * the client can show one (`src/lib/login-offer.ts`) — the same offer, under
 * the same policy, that a resource read is answered with.
 */
export function observedTool<A extends [unknown, ServerContext], R>(
	name: string,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | InputRequiredResult> {
	return observed(
		{ operation: name, announce: `${name} called` },
		offeringWhoopLogin(handler),
	);
}

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

import { observed } from "@/lib/observed";

/**
 * Wraps a resource read handler with redaction and stderr narration: the read
 * at `debug`, a success at `info` with its duration, a failure at `error`
 * carrying the message the client will see — scrubbed once, logged and thrown
 * as the same string.
 */
export function observedResource<A extends unknown[], R>(
	uri: string,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return observed({ operation: uri, announce: `reading ${uri}` }, handler);
}

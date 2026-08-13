/**
 * @file The wrapper every tool handler registers through: the shared
 * redact-and-narrate seam (`src/lib/observed.ts`), phrased for a tool — named
 * on stderr by the name a model called it by.
 */

import { observed } from "@/lib/observed";

/**
 * Wraps a tool handler with redaction and stderr narration: the call at
 * `debug`, a success at `info` with its duration, a failure at `error`
 * carrying the message the client will see — scrubbed once, logged and thrown
 * as the same string.
 */
export function observedTool<A extends unknown[], R>(
	name: string,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return observed({ what: name, announce: `${name} called` }, handler);
}

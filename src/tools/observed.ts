/**
 * @file The wrapper every tool handler registers through — one seam with two
 * jobs that belong together: anything thrown leaves redacted, and every call
 * lands on stderr with its outcome, so a host's log answers "what was asked,
 * and how did it go". The MCP SDK puts a thrown error's message on the wire
 * verbatim as the tool error, which makes this the one seam where a tool's
 * failures can be scrubbed — one scrub feeds both surfaces.
 */

import { log } from "@/lib/log";
import { describeRedacted } from "@/lib/redaction";

/**
 * Wraps a tool handler with redaction and stderr narration: the call at
 * `debug`, a success at `info` with its duration, a failure at `error`
 * carrying the message the client will see — scrubbed once, logged and thrown
 * as the same string.
 *
 * "Answered" means the handler resolved. The SDK still validates the result
 * against the tool's registered output schema after this returns, but the
 * fetch layer parses WHOOP's answers with the very schemas the tools
 * register, so a result failing that later check would take a bug in this
 * server's own code — not a state worth a second seam here.
 */
export function observedTool<A extends unknown[], R>(
	name: string,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args) => {
		log.debug(`${name} called`);
		const started = performance.now();
		try {
			const result = await handler(...args);
			log.info(
				`${name} answered in ${Math.round(performance.now() - started)}ms`,
			);

			return result;
		} catch (error) {
			const message = describeRedacted(error);
			log.error(
				`${name} failed after ${Math.round(performance.now() - started)}ms: ${message}`,
			);
			throw new Error(message);
		}
	};
}

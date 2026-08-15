/**
 * @file The seam every served handler runs inside — one place with two jobs
 * that belong together: anything thrown leaves redacted, and every call lands
 * on stderr with its outcome, so a host's log answers "what was asked, and how
 * did it go" whichever surface was asked.
 *
 * It sits in `lib/` rather than in either surface because both surfaces have
 * to behave identically here: the MCP SDK puts a thrown error's message on the
 * wire verbatim — as the tool error, and as the JSON-RPC error a failed
 * resource read is refused with — which makes this the one seam where either
 * surface's failures can be scrubbed. One scrub, one narration, no drift.
 */

import { isCancellation } from "./cancellation";
import { log } from "./log";
import { describeRedacted } from "./redaction";

/** How a call is spoken about on stderr. */
type ObservedCall = {
	/** What the outcome lines name: a tool's name, a resource's URI. */
	readonly operation: string;
	/** The line written when the call starts, in its surface's own words. */
	readonly announce: string;
};

/**
 * Wraps a handler with redaction and stderr narration: the call at `debug`, a
 * success at `info` with its duration, a failure at `error` carrying the
 * message the client will see — scrubbed once, logged and thrown as the same
 * string.
 *
 * "Answered" means the handler resolved. The SDK may still validate the result
 * afterwards — against a tool's registered output schema — but the fetch layer
 * parses WHOOP's answers with the very schemas the tools register, so a result
 * failing that later check would take a bug in this server's own code, not a
 * state worth a second seam here.
 */
export function observed<A extends unknown[], R>(
	{ operation, announce }: ObservedCall,
	handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args) => {
		log.debug(announce);
		const started = performance.now();
		try {
			const result = await handler(...args);
			log.info(
				`${operation} answered in ${Math.round(performance.now() - started)}ms`,
			);

			return result;
		} catch (error) {
			const message = describeRedacted(error);
			if (isCancellation(error)) {
				log.debug(
					`${operation} cancelled after ${Math.round(performance.now() - started)}ms: ${message}`,
				);
				throw error;
			}
			log.error(
				`${operation} failed after ${Math.round(performance.now() - started)}ms: ${message}`,
			);
			throw new Error(message);
		}
	};
}

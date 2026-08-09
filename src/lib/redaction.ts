/**
 * @file Keeps token material — access tokens, refresh tokens, the client
 * secret, authorization codes — off every outward surface, including when
 * WHOOP's own error bodies echo it back. Secrets are registered where they
 * enter the process, and outward formatters scrub through
 * {@link redactSecrets}, so new tools inherit the behaviour by using them.
 */

const REDACTED = "[redacted]";

/** Registered secrets, stored verbatim so they can be matched exactly. */
const knownSecrets = new Set<string>();

/**
 * Registers values to be scrubbed from outward surfaces. Call at the seams
 * secrets enter: the token store, WHOOP's token responses, the environment.
 *
 * Empty and absent values are ignored — registering `""` would match at every
 * position and destroy the whole message.
 */
export function registerSecrets(...values: (string | undefined)[]): void {
	for (const value of values) {
		if (value) {
			knownSecrets.add(value);
		}
	}
}

/** Replaces every registered secret in the given text with a marker. */
export function redactSecrets(text: string): string {
	let scrubbed = text;
	for (const secret of knownSecrets) {
		scrubbed = scrubbed.split(secret).join(REDACTED);
	}

	return scrubbed;
}

/** How much of a message written outside this process may be quoted onward. */
const EXCERPT_LIMIT = 300;

/**
 * Text from outside this process, made safe to quote: scrubbed of every
 * registered secret first, and only then cut to {@link EXCERPT_LIMIT}
 * characters, with an ellipsis when there was more to say.
 *
 * The order is the whole point. Cutting first could fall inside a secret and
 * leave a usable prefix behind, which exact-substring matching would no longer
 * recognise as anything to scrub; cutting text that is already scrubbed can
 * only ever yield more scrubbed text.
 */
export function redactedExcerpt(text: string): string {
	const scrubbed = redactSecrets(text);

	return scrubbed.length > EXCERPT_LIMIT
		? `${scrubbed.slice(0, EXCERPT_LIMIT)}…`
		: scrubbed;
}

/** An error's message, scrubbed, safe for an outward surface to carry. */
export function describeRedacted(error: unknown): string {
	return redactSecrets(error instanceof Error ? error.message : String(error));
}

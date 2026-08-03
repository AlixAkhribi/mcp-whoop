import { createInterface } from "node:readline";

import type { RedirectCapture } from "./redirect-listener";
import { type CapturedRedirect, classifyRedirect } from "./redirect-query";

/** What reading a pasted redirect needs in order to trust what arrives. */
export type PastedRedirectExpectation = {
	/** Where the line the user pastes is read from. */
	readonly input: NodeJS.ReadableStream;
	/** The anti-forgery value this login issued. */
	readonly expectedState: string;
};

/**
 * Classifies the pasted line. Once its query is in hand it is judged exactly as
 * a caught redirect is — a pasted URL earns no extra trust for having been
 * carried over by hand.
 */
function classifyPaste(
	pasted: string,
	expectedState: string,
): CapturedRedirect {
	let arrived: URL;
	try {
		arrived = new URL(pasted);
	} catch {
		return {
			authorized: false,
			failure: `that is not a URL (${pasted})`,
		};
	}

	return classifyRedirect(arrived.searchParams, expectedState);
}

/**
 * Reads the URL the browser ended up on from the user, for the redirects this
 * machine cannot catch itself: a redirect URI pointing somewhere else entirely,
 * or a loopback one whose port is already taken.
 *
 * The reader is deliberately not in terminal mode. A paste is a single line
 * with no editing to do and the terminal already echoes it, so readline has no
 * reason to take the input stream raw.
 */
export function readPastedRedirect({
	input,
	expectedState,
}: PastedRedirectExpectation): RedirectCapture {
	const reader = createInterface({ input, terminal: false });

	const captured = (async (): Promise<CapturedRedirect> => {
		for await (const line of reader) {
			const pasted = line.trim();
			if (pasted) {
				return classifyPaste(pasted, expectedState);
			}
		}

		return { authorized: false, failure: "no redirected URL was pasted" };
	})();

	return {
		captured,
		close: async () => {
			reader.close();
			input.pause();
		},
	};
}

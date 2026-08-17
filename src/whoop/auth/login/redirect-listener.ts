import { createServer, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import { type CapturedRedirect, classifyRedirect } from "./redirect-query";

/** A way back to the authorization code, however this login catches it. */
export type RedirectCapture = {
	/** Resolves the moment the browser arrives at the redirect URI. */
	readonly captured: Promise<CapturedRedirect>;
	/** Stops listening, dropping whatever the browser left open. */
	readonly close: () => Promise<void>;
};

/** A loopback listener waiting for WHOOP to redirect the browser back. */
export type LoopbackRedirectCapture = RedirectCapture & {
	/**
	 * Resolves once the redirect has been fully handled: the browser answered
	 * and, when a completion was supplied, that completion settled. Closing on
	 * this releases the port without cutting short the response — or the token
	 * exchange still writing the store — which {@link RedirectCapture.close}
	 * alone would.
	 */
	readonly answered: Promise<void>;
};

/** What the listener needs in order to trust what arrives. */
export type RedirectExpectation = {
	/** The URI WHOOP was told to send the browser to. */
	readonly redirectUri: URL;
	/** The anti-forgery value this login issued. */
	readonly expectedState: string;
	/**
	 * Finishes the login once the code is in hand. Runs before the browser is
	 * answered so the page reports the real outcome. The login command
	 * supplies none: its terminal reports the outcome instead.
	 */
	readonly complete?: (code: string) => Promise<void>;
};

/**
 * Whether this machine could listen on the redirect URI itself. Only http://
 * loopback qualifies: the listener speaks plain HTTP, and a hostname is only
 * loopback when it is a literal address — never a DNS name that resolves
 * wherever its owner points it.
 */
export function isLoopbackRedirect(redirectUri: URL): boolean {
	if (redirectUri.protocol !== "http:") {
		return false;
	}
	const { hostname } = redirectUri;

	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		(isIP(hostname) === 4 && hostname.startsWith("127."))
	);
}

/**
 * Shown once the code is handed over. A dead end by design; the same page
 * answers both login flows.
 */
const COMPLETE_PAGE = page("Login complete", "You can close this tab.");

/**
 * Shown for a redirect this login will not act on. Says nothing about why:
 * the reason is reported by the surface that started the login.
 */
const FAILED_PAGE = page(
	"Login failed",
	"The login did not complete. You can close this tab.",
);

/** One of the two pages this listener ever serves. */
function page(heading: string, detail: string): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		`<head><meta charset="utf-8"><title>${heading}</title></head>`,
		`<body><h1>${heading}</h1><p>${detail}</p></body>`,
		"</html>",
		"",
	].join("\n");
}

/** Sends a page to the browser sitting at the redirect URI. */
function answer(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		// The browser has no reason to hold this socket open, and a lingering
		// keep-alive connection would outlive the command that opened it.
		connection: "close",
	});
	response.end(body);
}

/**
 * Listens on the redirect URI's own port for WHOOP to send the browser back.
 * This is the automatic half of the login command: with a loopback redirect
 * registered, the user never copies a URL out of their address bar.
 */
export async function listenForRedirect({
	redirectUri,
	expectedState,
	complete,
}: RedirectExpectation): Promise<LoopbackRedirectCapture> {
	let capture: (redirect: CapturedRedirect) => void = () => {};
	const captured = new Promise<CapturedRedirect>((resolve) => {
		capture = resolve;
	});
	let finish: () => void = () => {};
	const answered = new Promise<void>((resolve) => {
		finish = resolve;
	});

	// Whether the elicited login's one redirect has arrived. Claimed
	// synchronously, before the exchange is awaited: two browsers carrying the
	// same valid redirect must run one exchange, not one each.
	let claimed = false;

	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", redirectUri.origin);
		if (arrived.pathname !== redirectUri.pathname) {
			response.writeHead(404, { connection: "close" }).end();

			return;
		}

		if (!complete) {
			// Login-command flow: the user watches a terminal, so the first
			// redirect — whatever it says — is the answer, and the response's
			// close marks the browser answered.
			response.once("close", finish);
			const redirect = classifyRedirect(arrived.searchParams, expectedState);
			answer(
				response,
				redirect.authorized ? 200 : 400,
				redirect.authorized ? COMPLETE_PAGE : FAILED_PAGE,
			);
			capture(redirect);

			return;
		}

		// Elicited flow: nobody watches a terminal, so the attempt must survive
		// anything but its own redirect. A request without this login's state
		// decides nothing; a second one with it is already answered.
		if (arrived.searchParams.get("state") !== expectedState || claimed) {
			answer(response, 400, FAILED_PAGE);

			return;
		}
		claimed = true;
		void (async () => {
			const redirect = classifyRedirect(arrived.searchParams, expectedState);
			// A matching-state error is WHOOP refusing this login, so it settles
			// the attempt the way a code does — minus the exchange.
			const completed = redirect.authorized
				? await complete(redirect.code).then(
						() => true,
						() => false,
					)
				: false;
			answer(
				response,
				completed ? 200 : 400,
				completed ? COMPLETE_PAGE : FAILED_PAGE,
			);
			capture(redirect);
			// Settled here, not on the response's close: Node fires close for a
			// browser that hangs up early, which would race the exchange still
			// writing the store.
			finish();
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			Number(redirectUri.port || 80),
			redirectUri.hostname,
			resolve,
		);
	});

	return {
		captured,
		answered,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	};
}

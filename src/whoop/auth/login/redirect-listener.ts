import { createServer, type ServerResponse } from "node:http";

import { type CapturedRedirect, classifyRedirect } from "./redirect-query";

/** A loopback listener waiting for WHOOP to redirect the browser back. */
export type RedirectCapture = {
	/** Resolves the moment the browser arrives at the redirect URI. */
	readonly captured: Promise<CapturedRedirect>;
	/** Stops listening, dropping whatever the browser left open. */
	readonly close: () => Promise<void>;
};

/** What the listener needs in order to trust what arrives. */
export type RedirectExpectation = {
	/** The URI WHOOP was told to send the browser to. */
	readonly redirectUri: URL;
	/** The anti-forgery value this login issued. */
	readonly expectedState: string;
};

/**
 * What the browser is left showing once it has handed the code over. The tab is
 * a dead end by design: the rest of the login happens in the terminal.
 */
const COMPLETE_PAGE = page(
	"Login complete",
	"You can close this tab and go back to your terminal.",
);

/**
 * What a redirect this login will not act on leaves on screen. It says nothing
 * about why: the reason belongs in the terminal, and a rejected redirect's text
 * is by definition not this login's own.
 */
const FAILED_PAGE = page(
	"Login failed",
	"You can close this tab. Your terminal has the details.",
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
}: RedirectExpectation): Promise<RedirectCapture> {
	let capture: (redirect: CapturedRedirect) => void = () => {};
	const captured = new Promise<CapturedRedirect>((resolve) => {
		capture = resolve;
	});

	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", redirectUri.origin);
		if (arrived.pathname !== redirectUri.pathname) {
			response.writeHead(404, { connection: "close" }).end();

			return;
		}

		const redirect = classifyRedirect(arrived.searchParams, expectedState);
		answer(
			response,
			redirect.authorized ? 200 : 400,
			redirect.authorized ? COMPLETE_PAGE : FAILED_PAGE,
		);
		capture(redirect);
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
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	};
}

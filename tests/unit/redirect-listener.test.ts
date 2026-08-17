import { request } from "node:http";

import { describe, expect, it } from "vitest";

import {
	isLoopbackRedirect,
	type LoopbackRedirectCapture,
	listenForRedirect,
} from "@/whoop/auth/login/redirect-listener";

import { deferCleanup, unusedRedirectUri } from "../helpers/harness";

/** The anti-forgery value the listener under test was told to expect. */
const EXPECTED_STATE = "the-state-this-login-issued";

/** Resolves after `ms`. */
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Whether `work` settles within `ms`, resolved or rejected. */
function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([
		work.then(
			() => true,
			() => true,
		),
		pause(ms).then(() => false),
	]);
}

/** A listener opened in the elicited mode, with what its exchange saw. */
type ElicitedListener = {
	/** Where WHOOP would send the browser back. */
	readonly callback: URL;
	readonly capture: LoopbackRedirectCapture;
	/** Every code the exchange was handed, in order. */
	readonly exchanged: string[];
};

/**
 * Opens a listener the way an elicited login does: the completion runs before
 * the browser is answered. `exchange` stands in for the token exchange.
 */
async function listenElicited(
	exchange: (code: string) => Promise<void> = async () => {},
): Promise<ElicitedListener> {
	const callback = new URL(await unusedRedirectUri());
	const exchanged: string[] = [];
	const capture = await listenForRedirect({
		redirectUri: callback,
		expectedState: EXPECTED_STATE,
		complete: async (code) => {
			exchanged.push(code);
			await exchange(code);
		},
	});
	deferCleanup(() => capture.close());

	return { callback, capture, exchanged };
}

/** A request back to the callback carrying `query`. */
async function redirectBack(
	callback: URL,
	query: Record<string, string>,
): Promise<{ status: number; body: string }> {
	const url = new URL(callback);
	for (const [name, value] of Object.entries(query)) {
		url.searchParams.set(name, value);
	}
	const response = await fetch(url);

	return { status: response.status, body: await response.text() };
}

describe("the redirect listener behind an elicited login", () => {
	it("answers a request without this login's state with the failure page, and keeps the attempt alive", async () => {
		const { callback, capture, exchanged } = await listenElicited();

		// Two requests no browser of this login sent: an error-shaped one with no
		// state, and one carrying a state this login never issued.
		const errorShaped = await redirectBack(callback, {
			error: "access_denied",
		});
		const wrongState = await redirectBack(callback, {
			code: "a-stolen-code",
			state: "a-state-from-somewhere-else",
		});

		expect(errorShaped.status).toBe(400);
		expect(wrongState.status).toBe(400);
		expect(exchanged).toEqual([]);
		expect(await settledWithin(capture.answered, 100)).toBe(false);

		const real = await redirectBack(callback, {
			code: "the-code",
			state: EXPECTED_STATE,
		});
		expect(real.status).toBe(200);
		expect(real.body).toMatch(/login complete/i);
		expect(exchanged).toEqual(["the-code"]);
		expect(await settledWithin(capture.answered, 1_000)).toBe(true);
	});

	it("runs the exchange once when two redirects carry the same valid state", async () => {
		const { callback, exchanged } = await listenElicited();

		const arrivals = await Promise.all([
			redirectBack(callback, { code: "the-code", state: EXPECTED_STATE }),
			redirectBack(callback, { code: "the-code", state: EXPECTED_STATE }),
		]);

		// Whichever arrived second is refused rather than traded for a second set
		// of tokens.
		expect(arrivals.map((arrival) => arrival.status).sort()).toEqual([
			200, 400,
		]);
		expect(exchanged).toEqual(["the-code"]);
	});

	it("settles the attempt on a matching-state refusal without running the exchange", async () => {
		const { callback, capture, exchanged } = await listenElicited();

		// An error carrying this login's state is WHOOP refusing this flow: the
		// one refusal that is this attempt's own answer.
		const refusal = await redirectBack(callback, {
			error: "access_denied",
			state: EXPECTED_STATE,
		});

		expect(refusal.status).toBe(400);
		expect(exchanged).toEqual([]);
		expect(await settledWithin(capture.answered, 1_000)).toBe(true);
	});

	it("holds `answered` for the exchange even when the browser hangs up early", async () => {
		let releaseExchange: () => void = () => {};
		const exchangeHeld = new Promise<void>((resolve) => {
			releaseExchange = resolve;
		});
		let announceExchange: () => void = () => {};
		const exchangeRunning = new Promise<void>((resolve) => {
			announceExchange = resolve;
		});
		const { callback, capture } = await listenElicited(async () => {
			announceExchange();
			await exchangeHeld;
		});

		// The real redirect arrives, and its browser walks away mid-exchange.
		const url = new URL(callback);
		url.searchParams.set("code", "the-code");
		url.searchParams.set("state", EXPECTED_STATE);
		const browser = request(url);
		browser.once("error", () => {});
		browser.end();
		await exchangeRunning;
		browser.destroy();

		// A closed connection must not read as answered: the exchange is still
		// writing the store, and tearing down here would race it.
		expect(await settledWithin(capture.answered, 150)).toBe(false);

		releaseExchange();
		expect(await settledWithin(capture.answered, 1_000)).toBe(true);
	});
});

describe("what counts as a loopback redirect this process could catch", () => {
	it("accepts plain http on 127.0.0.1, localhost, and [::1]", () => {
		expect(isLoopbackRedirect(new URL("http://127.0.0.1:8788/callback"))).toBe(
			true,
		);
		expect(isLoopbackRedirect(new URL("http://localhost:8788/callback"))).toBe(
			true,
		);
		expect(isLoopbackRedirect(new URL("http://[::1]:8788/callback"))).toBe(
			true,
		);
	});

	it("rejects a DNS name that merely begins with 127", () => {
		// Resolvable to anywhere its owner points it — a name is not an address.
		expect(
			isLoopbackRedirect(new URL("http://127.attacker.example/callback")),
		).toBe(false);
	});

	it("rejects https even on a genuine loopback address", () => {
		// The listener speaks plain HTTP, so an https redirect could be offered
		// but never completed.
		expect(isLoopbackRedirect(new URL("https://127.0.0.1:8788/callback"))).toBe(
			false,
		);
	});
});

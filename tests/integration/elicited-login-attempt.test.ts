import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	endEveryLoginAttempt,
	endLoginAttempt,
	type LoginAttempt,
	startLoginAttempt,
} from "@/whoop/auth/elicited/attempt";

import { temporaryStore, unusedRedirectUri } from "../helpers/harness";

/**
 * The lifetime a real attempt gets. A ref'd timer would hold the process open
 * for all ten minutes of it.
 */
const LIFETIME_MS = 600_000;

/**
 * How many timers are keeping this process's event loop alive.
 * `process.getActiveResourcesInfo` reports only what holds the loop open, so an
 * unref'd timer is by definition not among these.
 */
function timersHoldingTheLoop(): number {
	return process
		.getActiveResourcesInfo()
		.filter((resource) => resource === "Timeout").length;
}

/** The started attempt; throws a premise failure naming why none started. */
async function attemptStartedIn(env: NodeJS.ProcessEnv): Promise<LoginAttempt> {
	const started = await startLoginAttempt(env);
	if (!started.started) {
		throw new Error(`no login attempt was started: ${started.unavailable}`);
	}

	return started.attempt;
}

describe("the timer that ends an attempt nobody comes back to", () => {
	it("keeps nothing alive by itself: an idle process is free to go while it runs", async () => {
		// A whole application, store included, so nothing here reaches the real
		// store this machine keeps.
		const env = {
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: "a-client-secret",
			WHOOP_REDIRECT_URI: await unusedRedirectUri(),
			WHOOP_TOKEN_STORE: await temporaryStore(),
			WHOOP_LOGIN_TTL_MS: String(LIFETIME_MS),
		};

		const before = timersHoldingTheLoop();
		const attempt = await attemptStartedIn(env);
		const pending = timersHoldingTheLoop();
		// Ended here rather than left to the runner: the attempt holds a real
		// loopback port of this machine for ten minutes.
		await endLoginAttempt(attempt.requestState);

		expect(attempt.requestState).toMatch(/\S{16,}/);
		// The attempt's lifetime timer is unref'd, so it adds nothing this
		// process would have to wait for.
		expect(pending).toBe(before);
	});
});

/** Whether `port` can be bound on the loopback address; releases it again. */
async function bindable(port: number): Promise<boolean> {
	const probe = createServer();

	return new Promise<boolean>((resolve) => {
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => {
			probe.close(() => resolve(true));
		});
	});
}

// `endEveryLoginAttempt` refuses new attempts permanently, so these cases run
// last in this file, and the one about a start already in flight runs before
// the other.
describe("a login attempt still starting when every attempt is ended", () => {
	it("binds nothing it keeps: the start refuses, and the redirect port stays the machine's", async () => {
		const env = {
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: "a-client-secret",
			WHOOP_REDIRECT_URI: await unusedRedirectUri(),
			WHOOP_TOKEN_STORE: await temporaryStore(),
		};

		// The end arrives while the start is past the in-flight table's check but
		// not yet registered in it — the window draining that table alone misses.
		const starting = startLoginAttempt(env);
		await endEveryLoginAttempt();
		const started = await starting;

		expect(started.started).toBe(false);
		// Nothing of the refused start is left holding the port.
		expect(await bindable(Number(new URL(env.WHOOP_REDIRECT_URI).port))).toBe(
			true,
		);
	});
});

describe("a login attempt asked for after every attempt was ended", () => {
	it("refuses to start, and names the login that needs no conversation", async () => {
		await endEveryLoginAttempt();

		const started = await startLoginAttempt({
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: "a-client-secret",
			WHOOP_REDIRECT_URI: await unusedRedirectUri(),
			WHOOP_TOKEN_STORE: await temporaryStore(),
		});

		expect(started).toMatchObject({
			started: false,
			unavailable: expect.stringContaining("npx mcp-whoop login"),
		});
	});
});

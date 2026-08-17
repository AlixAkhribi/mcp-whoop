import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import type { CallToolResult, Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	type ElicitedUrl,
	listenOnLoopback,
	seedStore,
	temporaryStore,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The application credentials the serving environment provides. */
const APP = {
	clientId: "a-client-id",
	clientSecret: "a-client-secret",
} as const;

/** The profile the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** The code the stand-in WHOOP's consent screen sends the browser back with. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** The name of this server's only elicitation request. */
const WHOOP_LOGIN = "whoop_login";

type WhoopRequest = {
	readonly method: string;
	readonly path: string;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * A stand-in WHOOP serving the whole OAuth flow: its authorize endpoint
 * redirects the browser back with a code, its token endpoint trades that code
 * for tokens, and its data endpoint serves the profile. Nothing here walks the
 * flow — each case sends the browser off itself, when it wants to, or not at
 * all.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", "http://whoop.invalid");
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			requests.push({
				method: request.method ?? "",
				path: arrived.pathname,
			});

			if (arrived.pathname === "/oauth/oauth2/auth") {
				const back = new URL(arrived.searchParams.get("redirect_uri") ?? "");
				back.searchParams.set("code", AUTHORIZATION_CODE);
				back.searchParams.set("state", arrived.searchParams.get("state") ?? "");
				response
					.writeHead(302, { location: back.href, connection: "close" })
					.end();

				return;
			}

			const answer =
				arrived.pathname === "/oauth/oauth2/token"
					? {
							access_token: "an-access-token",
							refresh_token: "a-refresh-token",
							expires_in: 3600,
							scope: "read:profile offline",
							token_type: "bearer",
						}
					: arrived.pathname === "/developer/v2/user/profile/basic"
						? PROFILE
						: undefined;
			response.writeHead(answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/** One round's answer, with every possible shape's fields optional. */
type Answer = {
	readonly resultType?: string;
	readonly isError?: boolean;
	readonly requestState?: string;
	readonly inputRequests?: Record<
		string,
		{ readonly method: string; readonly params: Record<string, unknown> }
	>;
	readonly structuredContent?: unknown;
	readonly content?: readonly {
		readonly type: string;
		readonly text?: string;
	}[];
};

/** The retry fields a client sends back: the state, and any answers. */
type RetryRound = {
	readonly requestState?: string;
	readonly inputResponses?: Record<string, unknown>;
};

type ToolCallParams = Parameters<Client["callTool"]>[0];

/**
 * Calls a tool with the SDK's own retry driver switched off, so every round is
 * this test's to send and every answer arrives unfulfilled. `callTool` is typed
 * around a finished result, so the retry fields and the answer need casts.
 */
async function callRound(
	client: Client,
	retry: RetryRound = {},
): Promise<Answer> {
	return (await client.callTool(
		{ name: "get_profile", arguments: {}, ...retry } as ToolCallParams,
		{ allowInputRequired: true },
	)) as unknown as Answer;
}

/** The elicitation response of a user who accepted the consent link. */
const ACCEPTED = { [WHOOP_LOGIN]: { action: "accept" } };

/** The authorize URL an offer sends the user to. */
function authorizeUrlOf(offer: Answer): string {
	return String(offer.inputRequests?.[WHOOP_LOGIN]?.params.url);
}

/** The OAuth `state` in an offer's authorize URL. */
function stateOf(offer: Answer): string {
	return new URL(authorizeUrlOf(offer)).searchParams.get("state") ?? "";
}

/** Follows the consent link the way a browser would, redirect included. */
async function browse(offer: Answer): Promise<void> {
	await fetch(authorizeUrlOf(offer));
}

/** The outcome of a call left to the SDK's own retry driver to finish. */
type DrivenCall = {
	/** Whether it came back as a JSON-RPC error rather than a result. */
	readonly rejected: boolean;
	readonly result?: CallToolResult;
	readonly failure?: string;
};

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Whether the loopback port can be bound; releases it again immediately. */
async function bindable(port: number): Promise<boolean> {
	const probe = createServer();

	return new Promise<boolean>((resolve) => {
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => {
			probe.close(() => resolve(true));
		});
	});
}

/**
 * Whether the port becomes bindable within `ms`. Polls, since the server
 * releases it asynchronously.
 */
async function portFreedWithin(port: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await bindable(port)) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await pause(25);
	}
}

function requestsTo(whoop: FakeWhoop, path: string): WhoopRequest[] {
	return whoop.requests.filter((request) => request.path === path);
}

/**
 * The `requestState` of a second offer for the same attempt. Throws rather than
 * asserting, so a case built on one fails on its premise.
 */
function stateOfSecondOffer(second: Answer, first: Answer): string {
	if (
		second.resultType !== "input_required" ||
		typeof second.requestState !== "string" ||
		second.requestState !== first.requestState
	) {
		throw new Error(
			`the accept-retry answered no second offer for the same attempt: ${JSON.stringify(second)}`,
		);
	}

	return second.requestState;
}

describe("a WHOOP consent link accepted before the browser has finished", () => {
	it("an accept-retry that arrives before consent completes answers a second input_required carrying the same requestState", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();

		const { offer, waited } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				// Short enough to spend inside a test, long enough to be a real wait.
				env: { WHOOP_LOGIN_WAIT_MS: "150" },
			},
			async (client) => {
				const offer = await callRound(client);
				// Accepting the elicitation says nothing about consent having
				// completed: no browser has been to WHOOP yet.
				const waited = await callRound(client, {
					requestState: offer.requestState,
					inputResponses: ACCEPTED,
				});

				return { offer, waited };
			},
		);

		expect(offer.resultType).toBe("input_required");
		expect(Object.keys(offer.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);

		expect(waited.isError).not.toBe(true);
		expect(waited.resultType).toBe("input_required");
		// The same state means the same attempt, so the listener the first offer
		// bound is still the one WHOOP's redirect comes back to.
		expect(waited.requestState).toBe(offer.requestState);
		// No second elicitation: the user is already looking at the consent
		// screen.
		expect(waited.inputRequests ?? {}).toEqual({});
		expect(whoop.requests).toEqual([]);
	});

	it("serves the round that comes back once the browser has finished that same attempt", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();

		const { served } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				env: { WHOOP_LOGIN_WAIT_MS: "150" },
			},
			async (client) => {
				const offer = await callRound(client);
				const second = await callRound(client, {
					requestState: offer.requestState,
					inputResponses: ACCEPTED,
				});
				const carried = stateOfSecondOffer(second, offer);

				await browse(offer);

				// A state-only offer has nothing to fulfil, so the retry carries the
				// state alone.
				return { served: await callRound(client, { requestState: carried }) };
			},
		);

		expect(served.isError).not.toBe(true);
		expect(served.resultType).not.toBe("input_required");
		expect(served.structuredContent).toEqual(PROFILE);
		// One of each: waiting carried the first attempt forward instead of
		// starting a second.
		expect(requestsTo(whoop, "/oauth/oauth2/auth")).toHaveLength(1);
		expect(requestsTo(whoop, "/oauth/oauth2/token")).toHaveLength(1);
		expect(requestsTo(whoop, "/developer/v2/user/profile/basic")).toHaveLength(
			1,
		);
	});

	it("blocks the accept-retry and serves it in that same round when the browser gets there inside the budget", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();

		const { served } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				// Room for a browser that is on its way rather than abandoned.
				env: { WHOOP_LOGIN_WAIT_MS: "5000" },
			},
			async (client) => {
				const offer = await callRound(client);
				// Consent completes while the accept-retry round is still open.
				const browser = pause(100).then(() => browse(offer));
				const served = await callRound(client, {
					requestState: offer.requestState,
					inputResponses: ACCEPTED,
				});
				await browser;

				return { served };
			},
		);

		expect(served.isError).not.toBe(true);
		expect(served.resultType).not.toBe("input_required");
		expect(served.structuredContent).toEqual(PROFILE);
		expect(requestsTo(whoop, "/oauth/oauth2/auth")).toHaveLength(1);
		expect(requestsTo(whoop, "/developer/v2/user/profile/basic")).toHaveLength(
			1,
		);
	});

	it("leaves the loop to the client's own retry driver, asking it for nothing a second time", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();
		const elicited: ElicitedUrl[] = [];
		const rounds: number[] = [];

		const driven = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				// Too short for the browser below, so the round that fulfils the
				// offer cannot be the round that serves.
				env: { WHOOP_LOGIN_WAIT_MS: "1" },
				urlElicitation: {
					browser: (elicitation) => {
						elicited.push(elicitation);
						// A real client answers as soon as the browser opens, not when
						// consent completes.
						void pause(250).then(() =>
							fetch(elicitation.url).catch(() => undefined),
						);

						return "accept";
					},
				},
			},
			async (client): Promise<DrivenCall> => {
				try {
					return {
						rejected: false,
						result: await client.callTool(
							{ name: "get_profile", arguments: {} },
							{
								onprogress: ({ progress }) => {
									rounds.push(progress);
								},
							},
						),
					};
				} catch (error) {
					return { rejected: true, failure: String(error) };
				}
			},
		);

		// A round that asks for nothing needs no client capability, so there is no
		// missing-capability protocol error and the driver can keep looping.
		expect(driven.rejected).toBe(false);
		expect(driven.failure).toBeUndefined();
		expect(driven.result?.isError).not.toBe(true);
		expect(driven.result?.structuredContent).toEqual(PROFILE);
		// Exactly one consent screen: every round after the first asked the user
		// for nothing.
		expect(elicited).toHaveLength(1);
		// Progress notifications count the rounds the driver made on its own.
		expect(rounds.length).toBeGreaterThan(1);
	});
});

/** A `requestState` naming an attempt this server never started. */
const NEVER_MINTED = "not-a-name-this-server-ever-minted";

describe("a retry naming an attempt this process never started", () => {
	it("reads it as no attempt at all: the store again, then a fresh offer", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();

		const { fresh, waited } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				// Deliberately long: an unknown attempt has nothing to wait on, so
				// this round must not spend any of the budget.
				env: { WHOOP_LOGIN_WAIT_MS: "20000" },
			},
			async (client) => {
				const started = Date.now();
				const fresh = await callRound(client, {
					requestState: NEVER_MINTED,
					inputResponses: ACCEPTED,
				});

				return { fresh, waited: Date.now() - started };
			},
		);

		// Answered as a first round: a fresh consent link under a fresh name,
		// never an error about unknown state.
		expect(fresh.isError).not.toBe(true);
		expect(fresh.resultType).toBe("input_required");
		expect(Object.keys(fresh.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
		expect(fresh.requestState).toMatch(/\S{16,}/);
		expect(fresh.requestState).not.toBe(NEVER_MINTED);
		expect(waited).toBeLessThan(5_000);
	});

	it("serves the login the store is holding, whatever the name it came back under", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const served = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri: await unusedRedirectUri(),
				urlElicitation: {},
			},
			(client) => callRound(client, { requestState: NEVER_MINTED }),
		);

		// The store is read before any attempt state, so a state naming nothing
		// costs the call nothing.
		expect(served.isError).not.toBe(true);
		expect(served.resultType).not.toBe("input_required");
		expect(served.structuredContent).toEqual(PROFILE);
	});
});

describe("a retry whose login landed by another hand", () => {
	it("serves it and closes the attempt it names: the port comes back, and a later failure starts fresh", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();
		const port = Number(new URL(redirectUri).port);

		const { offer, served, freed, fresh } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
			},
			async (client) => {
				const offer = await callRound(client);
				expect(offer.resultType).toBe("input_required");
				// A login lands by another route — a terminal login, or another
				// process — while this attempt's browser never moves.
				await seedStore(store);

				const served = await callRound(client, {
					requestState: offer.requestState,
					inputResponses: ACCEPTED,
				});
				// Serving from the store closes the attempt the retry named, so its
				// listener and timer cannot later overwrite the newer login. Checked
				// while the server still runs, since the port frees on exit anyway.
				const freed = await portFreedWithin(port, 5_000);

				// Removing that login forces what follows to be a whole new attempt.
				await rm(join(store, "tokens.json"));

				return { offer, served, freed, fresh: await callRound(client) };
			},
		);

		expect(served.isError).not.toBe(true);
		expect(served.resultType).not.toBe("input_required");
		expect(served.structuredContent).toEqual(PROFILE);
		expect(freed).toBe(true);
		// The closed attempt is gone whole: the next offer carries a new
		// requestState and a new OAuth state.
		expect(fresh.resultType).toBe("input_required");
		expect(fresh.requestState).toMatch(/\S{16,}/);
		expect(fresh.requestState).not.toBe(offer.requestState);
		expect(stateOf(fresh)).toMatch(/\S{16,}/);
		expect(stateOf(fresh)).not.toBe(stateOf(offer));
	});
});

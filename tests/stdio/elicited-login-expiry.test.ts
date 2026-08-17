import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	temporaryStore,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The OAuth application the server under test is configured with. */
const APP = {
	clientId: "a-client-id",
	clientSecret: "a-client-secret",
} as const;

/** The profile the fake WHOOP serves, in the v2 API's snake_case shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** The authorization code the fake WHOOP redirects the browser back with. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** The name of the server's one elicitation request. */
const WHOOP_LOGIN = "whoop_login";

/**
 * A login attempt TTL short enough for a test to outlive, standing in for the
 * ten-minute default.
 */
const SHORT_LIFETIME_MS = 200;

/** The ten-minute default, set explicitly so no case here turns on expiry. */
const LONG_LIFETIME_MS = 600_000;

/**
 * How long `StdioClientTransport.close` waits for the server process to exit
 * before signalling it. A slower teardown means the process had to be killed.
 */
const SIGNALLED_AFTER_MS = 2_000;

/** One request the fake WHOOP received. */
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
 * A fake WHOOP serving the authorize, token, and profile endpoints. Its
 * authorize endpoint redirects back to the redirect URI with a code, as the
 * real one does; nothing walks that link unless a case does so itself.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			requests.push({ method: request.method ?? "", path: arrived.pathname });

			// Stands in for the consent screen: WHOOP redirects back to the
			// registered redirect URI with a code, echoing the state it was given.
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

/** The fields a tool-call round can come back with. */
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

/** The fields a retry round carries: its request state and any answers. */
type RetryRound = {
	readonly requestState?: string;
	readonly inputResponses?: Record<string, unknown>;
};

type ToolCallParams = Parameters<Client["callTool"]>[0];

/**
 * Calls a tool with the SDK's own elicitation driver off, so each round is the
 * test's to send. The casts are needed because `callTool` is typed around a
 * finished result rather than a round that asks for input.
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

/** The authorize URL an offer sends the user to. */
function authorizeUrlOf(offer: Answer): string {
	return String(offer.inputRequests?.[WHOOP_LOGIN]?.params.url);
}

/** The OAuth `state` in an offer's authorize URL. */
function stateOf(offer: Answer): string {
	return new URL(authorizeUrlOf(offer)).searchParams.get("state") ?? "";
}

/** The elicitation response for a user who accepts the consent link. */
const ACCEPTED = { [WHOOP_LOGIN]: { action: "accept" } };

/** What following a consent link through to the redirect URI found. */
type Arrival =
	/** The redirect URI answered: a listener was still up. */
	| "answered"
	/** Nothing was listening on the redirect URI. */
	| "refused";

/**
 * Follows a consent link through WHOOP and on to the redirect URI. A `fetch`
 * chasing the redirect to a port nobody holds rejects, which is the whole of
 * the distinction this reports.
 */
async function browse(offer: Answer): Promise<Arrival> {
	return fetch(authorizeUrlOf(offer)).then(
		() => "answered",
		() => "refused",
	);
}

/** The fake WHOOP's requests to one path. */
function requestsTo(whoop: FakeWhoop, path: string): WhoopRequest[] {
	return whoop.requests.filter((request) => request.path === path);
}

/** Resolves after `ms`. */
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Whether the loopback port can be bound right now; releases it again. */
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

describe("a WHOOP consent link nobody ever comes back to", () => {
	it("an attempt that expires without consent frees the redirect URI's port", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();
		const port = Number(new URL(redirectUri).port);

		const { offer, taken, freed } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				env: { WHOOP_LOGIN_TTL_MS: String(SHORT_LIFETIME_MS) },
			},
			async (client) => {
				const offer = await callRound(client);
				// Checked while the server still runs: the port would come back
				// anyway once the spawned process exits.
				const taken = !(await bindable(port));

				return { offer, taken, freed: await portFreedWithin(port, 5_000) };
			},
		);

		expect(offer.resultType).toBe("input_required");
		expect(taken).toBe(true);
		// Nothing consented and nothing declined: expiry alone freed the port.
		expect(freed).toBe(true);
		expect(whoop.requests).toEqual([]);
	});
});

describe("a retry carrying the name of an attempt that has since expired", () => {
	it("reads it as no attempt at all: the store again, then a fresh offer with a fresh authorize state", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();
		const port = Number(new URL(redirectUri).port);

		const { offer, fresh, waited } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				env: {
					WHOOP_LOGIN_TTL_MS: String(SHORT_LIFETIME_MS),
					// Deliberately generous: the attempt this retry names is gone, so
					// nothing should be left to wait on.
					WHOOP_LOGIN_WAIT_MS: "20000",
				},
			},
			async (client) => {
				const offer = await callRound(client);
				// Waits for the attempt to expire before the retry is sent.
				expect(await portFreedWithin(port, 5_000)).toBe(true);

				// A late retry carrying the requestState of the expired attempt.
				const started = Date.now();
				const fresh = await callRound(client, {
					requestState: offer.requestState,
					inputResponses: ACCEPTED,
				});

				return { offer, fresh, waited: Date.now() - started };
			},
		);

		expect(offer.resultType).toBe("input_required");

		expect(fresh.isError).not.toBe(true);
		expect(fresh.resultType).toBe("input_required");
		expect(Object.keys(fresh.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
		expect(fresh.requestState).toMatch(/\S{16,}/);
		expect(fresh.requestState).not.toBe(offer.requestState);
		// A fresh OAuth state: the one the expired listener waited for can no
		// longer answer anything.
		expect(stateOf(fresh)).toMatch(/\S{16,}/);
		expect(stateOf(fresh)).not.toBe(stateOf(offer));
		// Answered without waiting, despite the 20s budget: a requestState naming
		// no attempt is nothing to wait on.
		expect(waited).toBeLessThan(5_000);
	});
});

describe("a browser reaching the redirect URI after the attempt expired", () => {
	it("finds nothing listening for it, and no login is written to the store", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();
		const port = Number(new URL(redirectUri).port);

		const { offer, arrival } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				env: { WHOOP_LOGIN_TTL_MS: String(SHORT_LIFETIME_MS) },
			},
			async (client) => {
				const offer = await callRound(client);
				// Waits for the attempt, and its listener, to expire.
				expect(await portFreedWithin(port, 5_000)).toBe(true);

				// The consent link is walked only now, after the listener is gone.
				return { offer, arrival: await browse(offer) };
			},
		);

		expect(offer.resultType).toBe("input_required");
		expect(requestsTo(whoop, "/oauth/oauth2/auth")).toHaveLength(1);
		expect(arrival).toBe("refused");
		expect(requestsTo(whoop, "/oauth/oauth2/token")).toEqual([]);
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
	});
});

describe("a client closing the transport on a still-pending attempt", () => {
	it("gives the port back and lets the process go, without waiting to be signalled", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();
		const port = Number(new URL(redirectUri).port);

		const { offer, taken, closedIn, freed } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				// A long TTL: this attempt must still be pending when its client
				// goes away.
				env: { WHOOP_LOGIN_TTL_MS: String(LONG_LIFETIME_MS) },
			},
			async (client) => {
				const offer = await callRound(client);
				const taken = !(await bindable(port));

				// A graceful transport close, not a killed process.
				const started = Date.now();
				await client.close();
				const closedIn = Date.now() - started;

				return {
					offer,
					taken,
					closedIn,
					freed: await portFreedWithin(port, 5_000),
				};
			},
		);

		expect(offer.resultType).toBe("input_required");
		expect(taken).toBe(true);
		expect(freed).toBe(true);
		// Under the signal timeout means the process exited on its own: an
		// unclosed listener would have kept it alive until the client signalled.
		expect(closedIn).toBeLessThan(SIGNALLED_AFTER_MS);
	});
});

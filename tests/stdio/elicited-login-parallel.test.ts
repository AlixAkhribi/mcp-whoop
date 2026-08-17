import { rm } from "node:fs/promises";
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

/** The body measurements it serves, in the same v2 shape. */
const BODY_MEASUREMENTS = {
	height_meter: 1.78,
	weight_kilogram: 71.5,
	max_heart_rate: 191,
};

/** The authorization code the fake WHOOP redirects the browser back with. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** The scopes the fake WHOOP grants: enough for both tools called here. */
const GRANTED_SCOPES = ["read:profile", "read:body_measurement", "offline"];

/** The name of the server's one elicitation request. */
const WHOOP_LOGIN = "whoop_login";

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
 * A fake WHOOP serving the authorize and token endpoints plus the data both
 * tools here read. Its authorize endpoint redirects back to the redirect URI
 * with a code, as the real one does; nothing walks that link unless a case
 * does so itself.
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
							scope: GRANTED_SCOPES.join(" "),
							token_type: "bearer",
						}
					: arrived.pathname === "/developer/v2/user/profile/basic"
						? PROFILE
						: arrived.pathname === "/developer/v2/user/measurement/body"
							? BODY_MEASUREMENTS
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

/** An answer's text content, joined. */
function textOf(answer: Answer): string {
	return (answer.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

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
	tool: string,
	retry: RetryRound = {},
): Promise<Answer> {
	return (await client.callTool(
		{ name: tool, arguments: {}, ...retry } as ToolCallParams,
		{ allowInputRequired: true },
	)) as unknown as Answer;
}

/** The two tools called in parallel, each its own tool call. */
const IN_PARALLEL = ["get_profile", "get_body_measurements"] as const;

/** Issues both tool calls concurrently. */
function callInParallel(
	client: Client,
	retry: RetryRound = {},
): Promise<[Answer, Answer]> {
	return Promise.all([
		callRound(client, IN_PARALLEL[0], retry),
		callRound(client, IN_PARALLEL[1], retry),
	]);
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

/** The elicitation response for a user who declines. */
const DECLINED = { [WHOOP_LOGIN]: { action: "decline" } };

/**
 * The requestState both parallel rounds were offered. Throws rather than
 * asserting: a case built on a shared offer has a broken premise, not a failed
 * expectation, when the rounds were offered different attempts.
 */
function sharedOffer([first, second]: readonly [Answer, Answer]): string {
	if (
		first.resultType !== "input_required" ||
		typeof first.requestState !== "string" ||
		second.requestState !== first.requestState ||
		authorizeUrlOf(second) !== authorizeUrlOf(first)
	) {
		throw new Error(
			`the parallel rounds were not offered one attempt: ${JSON.stringify([first, second])}`,
		);
	}

	return first.requestState;
}

/** The fake WHOOP's requests to one path. */
function requestsTo(whoop: FakeWhoop, path: string): WhoopRequest[] {
	return whoop.requests.filter((request) => request.path === path);
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

/** Resolves after `ms`. */
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("two tool calls with no stored WHOOP login, issued in parallel", () => {
	it("shares one attempt between them: the same requestState, one listener, one authorize state", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();

		const { offers, portTaken } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
			},
			async (client) => {
				const offers = await callInParallel(client);

				// Checked while the server still runs: the port would come back
				// anyway once the spawned process exits.
				return {
					offers,
					portTaken: !(await bindable(Number(new URL(redirectUri).port))),
				};
			},
		);

		for (const offer of offers) {
			expect(offer.isError).not.toBe(true);
			expect(offer.resultType).toBe("input_required");
			expect(Object.keys(offer.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
			// A second listener would have surfaced here as an EADDRINUSE message.
			expect(textOf(offer)).not.toContain("already in use");
		}

		expect(offers[0].requestState).toMatch(/\S{16,}/);
		expect(offers[1].requestState).toBe(offers[0].requestState);
		expect(authorizeUrlOf(offers[1])).toBe(authorizeUrlOf(offers[0]));
		expect(stateOf(offers[0])).toMatch(/\S{16,}/);
		expect(portTaken).toBe(true);
	});

	it("serves both retries real data once one browser has walked the shared consent screen", async () => {
		const whoop = await startFakeWhoop();

		const { served } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri: await unusedRedirectUri(),
				urlElicitation: {},
			},
			async (client) => {
				const offers = await callInParallel(client);
				const shared = sharedOffer(offers);
				// One browser walks the shared consent link once.
				await fetch(authorizeUrlOf(offers[0]));

				return {
					served: await callInParallel(client, {
						requestState: shared,
						inputResponses: ACCEPTED,
					}),
				};
			},
		);

		for (const answer of served) {
			expect(answer.isError).not.toBe(true);
			expect(answer.resultType).not.toBe("input_required");
		}
		expect(served[0].structuredContent).toEqual(PROFILE);
		expect(served[1].structuredContent).toEqual(BODY_MEASUREMENTS);

		// Exactly one code exchange: WHOOP's refresh tokens are single-use, so a
		// second attempt would leave the losing race's login in the store.
		expect(requestsTo(whoop, "/oauth/oauth2/auth")).toHaveLength(1);
		expect(requestsTo(whoop, "/oauth/oauth2/token")).toHaveLength(1);
		expect(requestsTo(whoop, "/developer/v2/user/profile/basic")).toHaveLength(
			1,
		);
		expect(
			requestsTo(whoop, "/developer/v2/user/measurement/body"),
		).toHaveLength(1);
	});

	it("issues one authorize state for the two of them, never one each", async () => {
		const whoop = await startFakeWhoop();

		const offers = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri: await unusedRedirectUri(),
				urlElicitation: {},
			},
			(client) => callInParallel(client),
		);

		// Guards the reads below: a round without an offer carries no authorize
		// URL to take a state from.
		expect(offers.map((offer) => offer.resultType)).toEqual([
			"input_required",
			"input_required",
		]);

		// One anti-forgery value for both: the single redirect listener can only
		// ever answer one state.
		const states = offers.map(stateOf);
		expect(new Set(states).size).toBe(1);
		expect(states[0]).toMatch(/\S{16,}/);
	});
});

describe("one of two parallel calls declining the shared consent link", () => {
	it("tears the shared attempt down: the listener closes, the call still pending answers prose, and no link is offered again", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();

		const { declined, pending, next, portFreed } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
			},
			async (client) => {
				const shared = sharedOffer(await callInParallel(client));
				// Which of the two calls carries the decline is arbitrary.
				const declined = await callRound(client, IN_PARALLEL[0], {
					requestState: shared,
					inputResponses: DECLINED,
				});
				// The sibling call retries the attempt the decline just ended.
				const pending = await callRound(client, IN_PARALLEL[1], {
					requestState: shared,
				});

				return {
					declined,
					pending,
					next: await callRound(client, IN_PARALLEL[0]),
					portFreed: await portFreedWithin(
						Number(new URL(redirectUri).port),
						5_000,
					),
				};
			},
		);

		expect(declined.isError).toBe(true);
		expect(textOf(declined)).toContain("npx mcp-whoop login");
		expect(pending.resultType).not.toBe("input_required");
		expect(pending.inputRequests).toBeUndefined();
		expect(pending.isError).toBe(true);
		expect(textOf(pending)).toContain("npx mcp-whoop login");
		expect(next.resultType).not.toBe("input_required");
		expect(next.inputRequests).toBeUndefined();
		expect(next.isError).toBe(true);
		expect(portFreed).toBe(true);
		expect(whoop.requests).toEqual([]);
	});
});

describe("a waiter still blocking on the shared attempt when its sibling declines", () => {
	it("comes back promptly with the prose instead of sitting out its wait budget", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();

		const { declined, pending, waited } = await withBuiltStdioClient(
			{
				store: await temporaryStore(),
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
				// Deliberately generous: the decline must end the wait, not the
				// budget running out.
				env: { WHOOP_LOGIN_WAIT_MS: "20000" },
			},
			async (client) => {
				const shared = sharedOffer(await callInParallel(client));

				// This round blocks waiting for a browser that never arrives.
				const started = Date.now();
				const waiting = callRound(client, IN_PARALLEL[1], {
					requestState: shared,
				});
				// Long enough for that round to be waiting before the decline lands
				// on its sibling.
				await pause(100);
				const declined = await callRound(client, IN_PARALLEL[0], {
					requestState: shared,
					inputResponses: DECLINED,
				});

				return {
					declined,
					pending: await waiting,
					waited: Date.now() - started,
				};
			},
		);

		expect(declined.isError).toBe(true);
		// The decline wakes the waiting round, well inside its 20s budget.
		expect(pending.resultType).not.toBe("input_required");
		expect(pending.inputRequests).toBeUndefined();
		expect(pending.isError).toBe(true);
		expect(textOf(pending)).toContain("npx mcp-whoop login");
		expect(waited).toBeLessThan(5_000);
	});
});

describe("the attempt two parallel calls shared, once it is over", () => {
	it("leaves nothing behind: a later login-shaped failure starts a fresh attempt with a fresh state", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();
		const port = Number(new URL(redirectUri).port);

		const { offers, served, fresh } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
			},
			async (client) => {
				const offers = await callInParallel(client);
				const shared = sharedOffer(offers);
				await fetch(authorizeUrlOf(offers[0]));
				const served = await callInParallel(client, {
					requestState: shared,
					inputResponses: ACCEPTED,
				});

				// Deleting the store out of band is a login-shaped failure like any
				// other; the next call is the one that finds out.
				await rm(join(store, "tokens.json"));
				// The finished attempt must release the port before a fresh one can
				// bind it.
				expect(await portFreedWithin(port, 5_000)).toBe(true);

				return {
					offers,
					served,
					fresh: await callRound(client, IN_PARALLEL[0]),
				};
			},
		);

		expect(served[0].structuredContent).toEqual(PROFILE);
		expect(served[1].structuredContent).toEqual(BODY_MEASUREMENTS);

		expect(fresh.isError).not.toBe(true);
		expect(fresh.resultType).toBe("input_required");
		expect(Object.keys(fresh.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
		expect(fresh.requestState).toMatch(/\S{16,}/);
		expect(fresh.requestState).not.toBe(offers[0].requestState);
		expect(stateOf(fresh)).not.toBe(stateOf(offers[0]));
		expect(new URL(authorizeUrlOf(fresh)).pathname).toBe("/oauth/oauth2/auth");
	});
});

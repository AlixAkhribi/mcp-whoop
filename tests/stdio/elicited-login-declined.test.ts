import { readdir } from "node:fs/promises";
import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { runLogin } from "@/whoop/auth/login";

import {
	listenOnLoopback,
	temporaryStore,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The WHOOP application these cases put in the server's environment. */
const APP = {
	clientId: "a-client-id",
	clientSecret: "a-client-secret",
} as const;

/** The profile the fake WHOOP serves, in WHOOP's v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** The name the server's only elicitation is sent to a client under. */
const WHOOP_LOGIN = "whoop_login";

/** The code the browser carries back to the login that is listening. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** The scopes the fake WHOOP reports granting. */
const GRANTED_SCOPES = ["read:profile", "offline"];

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every path this WHOOP was asked for, in order. */
	readonly requests: string[];
};

/**
 * A fake WHOOP that trades an authorization code for tokens and serves the
 * basic profile, recording the paths it was asked for. It has no consent
 * screen: the only login in these cases is one run from a terminal.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			requests.push(arrived.pathname);
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

/** One round's answer, in any of the shapes a round can come back as. */
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

/** The text parts of an answer, joined. */
function textOf(answer: Answer): string {
	return (answer.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** What a retry round carries: the offer's state, and answers to it. */
type RetryRound = {
	readonly requestState?: string;
	readonly inputResponses?: Record<string, unknown>;
};

type ToolCallParams = Parameters<Client["callTool"]>[0];

/**
 * Calls a tool with the client's multi-round-trip driver off, so every round is
 * this test's to send and every answer arrives as itself. `retry` carries the
 * fields the driver would otherwise put on the wire; the SDK types `callTool`
 * around a finished result, hence the cast on both sides.
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

/** The client's answer when its user refused the link. */
const DECLINED = { [WHOOP_LOGIN]: { action: "decline" } };

/** The client's answer when it withdrew the question without asking. */
const CANCELLED = { [WHOOP_LOGIN]: { action: "cancel" } };

/** What a serving process needs before it could offer a consent link. */
type OfferableServer = {
	readonly store: string;
	readonly whoop: FakeWhoop;
	/** Piped only when a case reads what the process narrated. */
	readonly stderr?: "pipe";
};

/**
 * Runs `use` against a serving process that really could offer a consent link:
 * a client declaring URL-mode elicitation, an environment naming a whole WHOOP
 * application, and a free loopback redirect URI. Nothing mechanical withholds
 * an offer here.
 */
async function withOfferableServer<T>(
	{ store, whoop, stderr }: OfferableServer,
	use: (client: Client, stderr: () => string) => Promise<T>,
): Promise<T> {
	return withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			credentials: APP,
			redirectUri: await unusedRedirectUri(),
			urlElicitation: {},
			...(stderr === undefined ? {} : { stderr }),
		},
		(client, _transport, narrated) => use(client, narrated),
	);
}

/**
 * The `requestState` of an offer, insisted upon: a case that begins by refusing
 * one then fails on its premise rather than on a later expectation.
 */
function stateOfOffer(offer: Answer): string {
	if (
		offer.resultType !== "input_required" ||
		typeof offer.requestState !== "string"
	) {
		throw new Error(
			`the first round was not an offer to refuse: ${JSON.stringify(offer)}`,
		);
	}

	return offer.requestState;
}

describe("a WHOOP consent link the client's user declined", () => {
	it("answers the next tool call of that process with prose instead of a second offer", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { declined, next } = await withOfferableServer(
			{ store, whoop },
			async (client) => {
				const offer = await callRound(client, "get_profile");
				const declined = await callRound(client, "get_profile", {
					requestState: stateOfOffer(offer),
					inputResponses: DECLINED,
				});

				// A different tool, called as any first round is: nothing about this
				// call names the offer that was turned down.
				return {
					declined,
					next: await callRound(client, "get_body_measurements"),
				};
			},
		);

		expect(declined.isError).toBe(true);
		// A user who said no is not asked again for the life of this process.
		expect(next.resultType).not.toBe("input_required");
		expect(next.inputRequests).toBeUndefined();
		expect(next.isError).toBe(true);
		expect(textOf(next)).toContain("npx mcp-whoop login");
	});
});

/**
 * Declines a consent link in one serving process, and leaves that process. What
 * a decline is worth to the next process is what the cases below measure.
 */
async function declineInOneProcess(server: OfferableServer): Promise<void> {
	const refused = await withOfferableServer(server, async (client) => {
		const offer = await callRound(client, "get_profile");

		return callRound(client, "get_profile", {
			requestState: stateOfOffer(offer),
			inputResponses: DECLINED,
		});
	});

	expect(refused.isError).toBe(true);
}

describe("a WHOOP consent link declined in a serving process that has since ended", () => {
	it("offers a fresh serving process against that same store a link again, having written the decline nowhere", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		await declineInOneProcess({ store, whoop });

		// A decline lives only in the process that saw it, never in the store: it
		// is not a setting a user would have to find and undo.
		expect(await readdir(store)).toEqual([]);

		// A second process, against the same store, from the same environment.
		const offer = await withOfferableServer({ store, whoop }, (client) =>
			callRound(client, "get_profile"),
		);

		expect(offer.resultType).toBe("input_required");
		expect(Object.keys(offer.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
	});
});

/**
 * Runs the login command the way the refused client's prose tells a user to: in
 * their own terminal, against the same store the serving process reads. The
 * browser is stood in for by fetching the command's own loopback listener with
 * a code to trade.
 */
async function loginFromATerminal({
	store,
	whoop,
}: OfferableServer): Promise<void> {
	const redirectUri = await unusedRedirectUri();
	let announce: (url: URL) => void = () => {};
	const printedUrl = new Promise<URL>((resolve) => {
		announce = resolve;
	});
	const failures: string[] = [];
	const exitCode = runLogin({
		env: {
			WHOOP_CLIENT_ID: APP.clientId,
			WHOOP_CLIENT_SECRET: APP.clientSecret,
			WHOOP_REDIRECT_URI: redirectUri,
			WHOOP_API_BASE_URL: whoop.baseUrl,
			WHOOP_TOKEN_STORE: store,
		},
		print: (message) => {
			const found = message.match(/https?:\/\/\S*\/oauth\/oauth2\/auth\S*/);
			if (found) {
				announce(new URL(found[0]));
			}
		},
		printFailure: (message) => failures.push(message),
		openBrowser: () => {},
	});

	const authorizeUrl = await printedUrl;
	const back = new URL(redirectUri);
	back.searchParams.set("code", AUTHORIZATION_CODE);
	back.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
	await fetch(back);

	expect(failures).toEqual([]);
	expect(await exitCode).toBe(0);
}

describe("a WHOOP consent link declined, and a login that happened anyway", () => {
	it("serves the data to the next tool call once the login command has been run against that store", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const served = await withOfferableServer(
			{ store, whoop },
			async (client) => {
				const offer = await callRound(client, "get_profile");
				const declined = await callRound(client, "get_profile", {
					requestState: stateOfOffer(offer),
					inputResponses: DECLINED,
				});
				expect(declined.isError).toBe(true);

				// The user goes and does what the prose sent them off to do.
				await loginFromATerminal({ store, whoop });

				return callRound(client, "get_profile");
			},
		);

		// A decline withholds offers and nothing else: the store is still the
		// ground truth every read starts from, so a login that landed by any route
		// is one this process reads with.
		expect(served.isError).not.toBe(true);
		expect(served.resultType).not.toBe("input_required");
		expect(served.structuredContent).toEqual(PROFILE);
		expect(whoop.requests).toContain("/developer/v2/user/profile/basic");
	});
});

describe("a WHOOP consent link the client cancelled", () => {
	it("offers the next tool call of that process a fresh consent link", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { cancelled, refused, next } = await withOfferableServer(
			{ store, whoop },
			async (client) => {
				const offer = await callRound(client, "get_profile");
				const cancelled = stateOfOffer(offer);
				const refused = await callRound(client, "get_profile", {
					requestState: cancelled,
					inputResponses: CANCELLED,
				});

				return {
					cancelled,
					refused,
					next: await callRound(client, "get_body_measurements"),
				};
			},
		);

		expect(refused.isError).toBe(true);
		// A cancel is the client withdrawing the question, not a user's no: nothing
		// was decided for this process to remember, so offers go on.
		expect(next.resultType).toBe("input_required");
		expect(Object.keys(next.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
		expect(next.requestState).toMatch(/\S{16,}/);
		expect(next.requestState).not.toBe(cancelled);

		// A whole second attempt, not the ended one re-served.
		const offered = new URL(
			String(next.inputRequests?.[WHOOP_LOGIN]?.params.url),
		);
		expect(offered.origin).toBe(new URL(whoop.baseUrl).origin);
		expect(offered.pathname).toBe("/oauth/oauth2/auth");
	});
});

describe("a WHOOP consent link declined by a round naming no attempt", () => {
	it("decides nothing: the round is answered like any first call, and offers go on", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { unmoored, next } = await withOfferableServer(
			{ store, whoop },
			async (client) => {
				// A decline carrying no requestState: nothing correlates it to a
				// question this process asked its user.
				const unmoored = await callRound(client, "get_profile", {
					inputResponses: DECLINED,
				});

				return {
					unmoored,
					next: await callRound(client, "get_body_measurements"),
				};
			},
		);

		// It names no attempt, so there is nothing to refuse.
		expect(unmoored.resultType).toBe("input_required");
		expect(Object.keys(unmoored.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
		expect(next.resultType).toBe("input_required");
		expect(Object.keys(next.inputRequests ?? {})).toEqual([WHOOP_LOGIN]);
	});
});

describe("a WHOOP consent link declined under the name of an attempt already over", () => {
	it("still stands: a late decline is the user's answer, and the offers stop", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { refused, next } = await withOfferableServer(
			{ store, whoop },
			async (client) => {
				const offer = await callRound(client, "get_profile");
				const stale = stateOfOffer(offer);
				const cancelled = await callRound(client, "get_profile", {
					requestState: stale,
					inputResponses: CANCELLED,
				});
				expect(cancelled.isError).toBe(true);

				// The user's no arrives after the cancel, naming the same attempt.
				const refused = await callRound(client, "get_profile", {
					requestState: stale,
					inputResponses: DECLINED,
				});

				return {
					refused,
					next: await callRound(client, "get_body_measurements"),
				};
			},
		);

		expect(refused.isError).toBe(true);
		// The decline was honoured although the attempt it named was already over.
		expect(next.resultType).not.toBe("input_required");
		expect(next.inputRequests).toBeUndefined();
		expect(next.isError).toBe(true);
		expect(textOf(next)).toContain("npx mcp-whoop login");
	});
});

/** What the serving process narrates when it stops offering consent links. */
const SUPPRESSED = "offers no more consent links";

/** How many times `phrase` occurs in `narrated`. */
function timesSaid(narrated: string, phrase: string): number {
	return narrated.split(phrase).length - 1;
}

describe("what a serving process narrates about a decline", () => {
	it("says once on stderr that it is offering no more consent links", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const narrated = await withOfferableServer(
			{ store, whoop, stderr: "pipe" },
			async (client, stderr) => {
				const offer = await callRound(client, "get_profile");
				const declined = await callRound(client, "get_profile", {
					requestState: stateOfOffer(offer),
					inputResponses: DECLINED,
				});
				expect(declined.isError).toBe(true);

				// Two more calls that would each have been offered a link, to show
				// the line is not repeated per call.
				await callRound(client, "get_profile");
				const last = await callRound(client, "get_body_measurements");
				// The last call's failure line is written after anything suppression
				// had to say, so waiting for it means the stream has caught up.
				await vi.waitFor(() => {
					expect(stderr()).toContain("get_body_measurements failed");
				});
				expect(last.isError).toBe(true);

				return stderr();
			},
		);

		expect(narrated).toContain(SUPPRESSED);
		expect(timesSaid(narrated, SUPPRESSED)).toBe(1);
		expect(narrated).toContain("npx mcp-whoop login");
	});
});

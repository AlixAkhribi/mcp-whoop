import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";
import {
	readStoredTokens,
	type StoredTokens,
	writeStoredTokens,
} from "@/whoop/auth/tokens/store";

import {
	type ElicitedAction,
	type ElicitedUrl,
	listenOnLoopback,
	temporaryStore,
	type UrlElicitation,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The profile the fake WHOOP serves, in WHOOP's v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/**
 * The application recorded beside the stored tokens. These cases spawn the
 * server with no `env` block, so the store is the only place a re-login can
 * learn which application to ask consent for.
 */
const STORED_APPLICATION = {
	clientId: "stored-client-id",
	clientSecret: "stored-client-secret",
} as const;

/** The refresh token WHOOP has stopped honouring. */
const DEAD_REFRESH_TOKEN = "dead-refresh-token";

/** The pair a re-login earns, and the only one the profile endpoint serves. */
const FRESH_ACCESS_TOKEN = "fresh-access-token";
const FRESH_REFRESH_TOKEN = "fresh-refresh-token";

/** The code the fake WHOOP's consent screen redirects back with. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** The scopes seeded in the store, and the ones a re-login earns by default. */
const GRANT = ["read:profile", OFFLINE_SCOPE];

/**
 * The OAuth errors WHOOP refuses a refresh token with: the spec's own
 * `invalid_grant`, the `invalid_request` the real WHOOP gives a revoked token,
 * and the `invalid_scope` a scope disabled in the dashboard since the login
 * earns. All three mean the login is dead.
 */
const DEAD_LOGIN_ANSWERS = [
	"invalid_grant",
	"invalid_request",
	"invalid_scope",
];

/**
 * The refresh failures that say nothing about the login: WHOOP rate-limiting
 * this server, and an outage on WHOOP's side.
 */
const RETRYABLE_STATUSES = [429, 503];

type WhoopRequest = {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | undefined;
	readonly form: URLSearchParams;
};

/**
 * How the fake WHOOP turns a refresh grant down: with an OAuth error meaning
 * the login is dead, or with a status a retry could get past.
 */
type RefusedRefresh =
	| { readonly deadLogin: string }
	| { readonly retryableStatus: number };

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * A fake WHOOP that refuses the refresh grant as the case asks, and can still
 * serve a whole login afterwards: authorize redirects back with a code, token
 * trades it for the fresh pair, and profile answers only to that pair.
 */
async function startFakeWhoop({
	refusing,
	granting,
}: {
	readonly refusing: RefusedRefresh;
	readonly granting: readonly string[];
}): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", "http://whoop.invalid");
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
			requests.push({
				method: request.method ?? "",
				path: arrived.pathname,
				authorization: request.headers.authorization,
				form,
			});
			const answer = (status: number, payload: unknown): void => {
				response.writeHead(status, {
					"content-type": "application/json",
					connection: "close",
				});
				response.end(JSON.stringify(payload));
			};

			// Consent is automatic: redirect straight back to the registered URI
			// with a code and the state that was given.
			if (arrived.pathname === "/oauth/oauth2/auth") {
				const back = new URL(arrived.searchParams.get("redirect_uri") ?? "");
				back.searchParams.set("code", AUTHORIZATION_CODE);
				back.searchParams.set("state", arrived.searchParams.get("state") ?? "");
				response
					.writeHead(302, { location: back.href, connection: "close" })
					.end();

				return;
			}

			if (arrived.pathname === "/oauth/oauth2/token") {
				if (form.get("grant_type") === "refresh_token") {
					if ("deadLogin" in refusing) {
						answer(400, { error: refusing.deadLogin });
					} else {
						answer(refusing.retryableStatus, { error: "server_error" });
					}

					return;
				}
				answer(200, {
					access_token: FRESH_ACCESS_TOKEN,
					refresh_token: FRESH_REFRESH_TOKEN,
					expires_in: 3600,
					scope: granting.join(" "),
					token_type: "bearer",
				});

				return;
			}

			if (arrived.pathname === "/developer/v2/user/profile/basic") {
				// The stale access token 401s here the way it would upstream.
				const authorized =
					request.headers.authorization === `Bearer ${FRESH_ACCESS_TOKEN}`;
				answer(
					authorized ? 200 : 401,
					authorized ? PROFILE : { error: "invalid_token" },
				);

				return;
			}

			answer(404, {});
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/**
 * Seeds a login WHOOP will not renew: the access token is already expired, so
 * the next call must refresh, and the refresh token it would spend is the dead
 * one. The application and redirect URI ride along because that is what a login
 * records (ADR 0003), and all a server with no environment has to go on.
 */
async function seedDeadLogin(
	store: string,
	redirectUri: string,
	scopes: readonly string[],
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "expired-access-token",
			refreshToken: DEAD_REFRESH_TOKEN,
			expiresAt: Date.now() - 60_000,
			scopes,
			application: { ...STORED_APPLICATION, redirectUri },
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/** A tool result, including the fields an `input_required` answer carries. */
type InputRequiredAnswer = {
	readonly resultType?: string;
	readonly isError?: boolean;
	readonly structuredContent?: unknown;
	readonly inputRequests?: Record<
		string,
		{ readonly method: string; readonly params: Record<string, unknown> }
	>;
	readonly content?: readonly {
		readonly type: string;
		readonly text?: string;
	}[];
};

/** The text parts of an answer, joined. */
function textOf(answer: InputRequiredAnswer): string {
	return (answer.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** A call's outcome, including a rejection. */
type ToolAnswer = InputRequiredAnswer & {
	/** Whether it came back as a JSON-RPC error rather than a result. */
	readonly rejected: boolean;
	/** The answer's prose, or the error if it was rejected. */
	readonly text: string;
};

type CallDriving = {
	/**
	 * Whether the client's own multi-round-trip driver runs, fulfilling each
	 * offer against the scripted browser; the answer is then the last round's.
	 */
	readonly retrying?: boolean;
};

/**
 * Calls a tool, treating every way it can answer as an answer. Without
 * `retrying`, the client's multi-round-trip driver is off, so an
 * `input_required` answer arrives as itself; the SDK types the call as a
 * finished result either way, hence the cast.
 */
async function answerTo(
	client: Client,
	name: string,
	{ retrying = false }: CallDriving = {},
): Promise<ToolAnswer> {
	try {
		const answer = (await client.callTool(
			{ name, arguments: {} },
			retrying ? undefined : { allowInputRequired: true },
		)) as unknown as InputRequiredAnswer;

		return { ...answer, rejected: false, text: textOf(answer) };
	} catch (error) {
		return { rejected: true, text: String(error) };
	}
}

/** What one call against a dead login is run against. */
type DeadLoginWorld = {
	readonly whoop: FakeWhoop;
	readonly store: string;
	readonly redirectUri: string;
	/** Every URL this client was asked to open, in order. */
	readonly elicited: ElicitedUrl[];
};

type DeadLoginSetup = {
	/** How WHOOP turns the refresh grant down; a dead login by default. */
	readonly refusing?: RefusedRefresh;
	/** The grant the store records before the call. */
	readonly seeded?: readonly string[];
	/** The grant WHOOP hands out to a re-login. */
	readonly granting?: readonly string[];
	/**
	 * How this client's browser answers a consent link. Present at all, even
	 * empty, the client declares URL-mode elicitation; absent, it declares none
	 * and no link may be put in front of it.
	 */
	readonly urlElicitation?: UrlElicitation;
};

/**
 * Runs a client against a server whose stored login WHOOP will not renew. The
 * server is spawned with no WHOOP application environment — the documented MCP
 * client configuration — so a re-login has only the store to go on.
 */
async function withDeadLogin<T>(
	{
		refusing = { deadLogin: "invalid_grant" },
		seeded = GRANT,
		granting = GRANT,
		urlElicitation,
	}: DeadLoginSetup,
	use: (connected: Client, world: DeadLoginWorld) => Promise<T>,
): Promise<T> {
	const whoop = await startFakeWhoop({ refusing, granting });
	const store = await temporaryStore();
	const redirectUri = await unusedRedirectUri();
	const elicited: ElicitedUrl[] = [];
	await seedDeadLogin(store, redirectUri, seeded);

	return withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			...(urlElicitation === undefined
				? {}
				: {
						urlElicitation: {
							browser: async (elicitation): Promise<ElicitedAction> => {
								elicited.push(elicitation);

								return (
									(await urlElicitation.browser?.(elicitation)) ?? "cancel"
								);
							},
						},
					}),
		},
		(connected) => use(connected, { whoop, store, redirectUri, elicited }),
	);
}

/** One `get_profile` call's answer, and the world it ran against. */
type DeadLoginCall = DeadLoginWorld & { readonly answer: ToolAnswer };

/** Calls `get_profile` once against such a world. */
async function callAgainstDeadLogin(
	setup: DeadLoginSetup,
	driving: CallDriving = {},
): Promise<DeadLoginCall> {
	return withDeadLogin(setup, async (client, world) => ({
		answer: await answerTo(client, "get_profile", driving),
		...world,
	}));
}

/**
 * A browser that opens the link and consents: `fetch` follows WHOOP's redirect
 * back to the loopback URI, which is what completes the login.
 */
async function consenting(elicitation: ElicitedUrl): Promise<ElicitedAction> {
	await fetch(elicitation.url);

	return "accept";
}

/** The tokens the store holds now, read from outside the serving process. */
async function storedNow(store: string): Promise<StoredTokens | undefined> {
	return readStoredTokens({ env: { WHOOP_TOKEN_STORE: store } });
}

/** The authorize URL an offer sends the user to. */
function elicitedAuthorizeUrl(answer: InputRequiredAnswer): URL {
	return new URL(String(answer.inputRequests?.whoop_login?.params.url));
}

/** Every request the fake WHOOP served at `path`. */
function requestsTo(whoop: FakeWhoop, path: string): WhoopRequest[] {
	return whoop.requests.filter((request) => request.path === path);
}

describe("a tool call whose stored WHOOP login WHOOP will not renew, over real stdio", () => {
	it("answers input_required carrying the whoop_login elicitation rather than the dead-login prose", async () => {
		const { answer, redirectUri, whoop } = await callAgainstDeadLogin({
			urlElicitation: {},
		});

		expect(answer.isError).not.toBe(true);
		expect(answer.resultType).toBe("input_required");
		expect(Object.keys(answer.inputRequests ?? {})).toEqual(["whoop_login"]);
		expect(answer.inputRequests?.whoop_login?.method).toBe(
			"elicitation/create",
		);
		expect(answer.inputRequests?.whoop_login?.params.mode).toBe("url");
		expect(answer.text).not.toContain("no longer valid");

		// The link can only have come from what the store recorded: this process
		// carries no WHOOP environment of its own.
		const authorizeUrl = elicitedAuthorizeUrl(answer);
		expect(authorizeUrl.origin).toBe(new URL(whoop.baseUrl).origin);
		expect(authorizeUrl.pathname).toBe("/oauth/oauth2/auth");
		expect(authorizeUrl.searchParams.get("client_id")).toBe(
			STORED_APPLICATION.clientId,
		);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
	});

	it("serves the data on the retry and leaves the rotated pair in the store, the dead refresh token gone", async () => {
		const { answer, store, whoop, elicited } = await callAgainstDeadLogin(
			{ urlElicitation: { browser: consenting } },
			{ retrying: true },
		);

		expect(elicited).toHaveLength(1);
		expect(answer.isError).not.toBe(true);
		expect(answer.structuredContent).toEqual(PROFILE);
		expect(
			requestsTo(whoop, "/developer/v2/user/profile/basic").map(
				(request) => request.authorization,
			),
		).toEqual([`Bearer ${FRESH_ACCESS_TOKEN}`]);

		// The store is the only thing later processes share with this one.
		const stored = await storedNow(store);
		expect(stored?.accessToken).toBe(FRESH_ACCESS_TOKEN);
		expect(stored?.refreshToken).toBe(FRESH_REFRESH_TOKEN);
		expect(stored?.refreshToken).not.toBe(DEAD_REFRESH_TOKEN);
	});

	it("answers a client that cannot open a URL with the dead-login prose it always got", async () => {
		// No `urlElicitation` at all: the client declares no elicitation
		// capability, so no link may be put in front of it.
		const { answer, whoop } = await callAgainstDeadLogin({});

		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("The stored WHOOP login is no longer valid");
		expect(answer.text).toContain("npx mcp-whoop login");
		// No login was started behind its back either.
		expect(requestsTo(whoop, "/oauth/oauth2/auth")).toEqual([]);
	});

	it("offers the same login for every answer WHOOP calls a dead one by", async () => {
		const calls: DeadLoginCall[] = [];
		for (const deadLogin of DEAD_LOGIN_ANSWERS) {
			calls.push(
				await callAgainstDeadLogin({
					refusing: { deadLogin },
					urlElicitation: {},
				}),
			);
		}

		expect(calls.map((call) => call.answer.resultType)).toEqual([
			"input_required",
			"input_required",
			"input_required",
		]);
		expect(
			calls.map((call) => Object.keys(call.answer.inputRequests ?? {})),
		).toEqual([["whoop_login"], ["whoop_login"], ["whoop_login"]]);
		expect(calls.map((call) => call.answer.isError)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("makes no offer when the refresh fails in a way a retry could get past", async () => {
		const calls: DeadLoginCall[] = [];
		for (const retryableStatus of RETRYABLE_STATUSES) {
			calls.push(
				await callAgainstDeadLogin(
					{ refusing: { retryableStatus }, urlElicitation: {} },
					// Driven by the client's retry machinery, so an offer that did go
					// out would be carried through to WHOOP and show up here.
					{ retrying: true },
				),
			);
		}

		// The login may well be alive, so these keep the classification they
		// already had rather than asking a user to replace it.
		expect(calls.map((call) => call.answer.resultType)).toEqual([
			undefined,
			undefined,
		]);
		expect(calls.map((call) => call.answer.isError)).toEqual([true, true]);
		expect(calls.map((call) => call.elicited)).toEqual([[], []]);
		expect(calls[0]?.answer.text).toContain("rate-limited");
		expect(calls[0]?.answer.text).toContain("safe to retry");
		expect(calls[1]?.answer.text).toContain("temporarily unavailable");
		expect(calls[1]?.answer.text).toContain("safe to retry");
		expect(
			calls.flatMap((call) => requestsTo(call.whoop, "/oauth/oauth2/auth")),
		).toEqual([]);
	});

	it("records a re-login's narrower grant, leaving the advertised tools to the next restart", async () => {
		const { answer, store, advertised } = await withDeadLogin(
			{
				// A full grant at startup registers every tool; the re-login earns
				// only the profile back.
				seeded: [...DEFAULT_READ_SCOPES, OFFLINE_SCOPE],
				granting: GRANT,
				urlElicitation: { browser: consenting },
			},
			async (client, world) => ({
				answer: await answerTo(client, "get_profile", { retrying: true }),
				advertised: (await client.listTools()).tools.map((tool) => tool.name),
				...world,
			}),
		);

		expect(answer.isError).not.toBe(true);
		// The recorded grant is replaced by what WHOOP granted this time, not
		// added to.
		expect((await storedNow(store))?.scopes).toEqual(GRANT);

		// The tool listing is fixed at startup: a running process cannot track a
		// grant rewritten underneath it, so the restart every reconnecting client
		// performs is what narrows it. Scopes are still enforced per call.
		expect(advertised).toContain("get_workout");
		const afterRestart = await withBuiltStdioClient({ store }, async (client) =>
			(await client.listTools()).tools.map((tool) => tool.name),
		);
		expect(afterRestart).toEqual(["get_profile"]);
	});
});

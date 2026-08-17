import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import type { CallToolResult, Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";

import {
	type BuiltStdioClientOptions,
	type ElicitedAction,
	type ElicitedUrl,
	listenOnLoopback,
	temporaryStore,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The application the serving environment describes in these cases. */
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

/** What the stand-in WHOOP says it granted, which need not be what was asked. */
const GRANTED_SCOPES = ["read:profile", "read:sleep", "offline"];

/** One request the stand-in WHOOP was asked to serve. */
type WhoopRequest = {
	readonly method: string;
	readonly path: string;
	readonly form: URLSearchParams;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * A stand-in WHOOP covering the whole consent flow: the authorize endpoint
 * redirects the browser back with a code, the token endpoint trades the code
 * for tokens, and the data endpoint serves the profile.
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
				form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
			});

			// The authorize endpoint: redirect back with a code and the given state.
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

/** The input-required answer a multi-round-trip handler asks for more with. */
type InputRequiredAnswer = {
	readonly resultType?: string;
	readonly isError?: boolean;
	readonly requestState?: string;
	readonly inputRequests?: Record<
		string,
		{ readonly method: string; readonly params: Record<string, unknown> }
	>;
	readonly content?: readonly {
		readonly type: string;
		readonly text?: string;
	}[];
};

/** The concatenated text content of an answer. */
function textOf(answer: InputRequiredAnswer): string {
	return (answer.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** A call's outcome, however it came back. */
type ToolAnswer = InputRequiredAnswer & {
	/** Whether it came back as a JSON-RPC error instead of a result at all. */
	readonly rejected: boolean;
	/** The answer's text, or the failure's message. */
	readonly text: string;
};

/** How a call is driven, and therefore which round's answer comes back. */
type CallDriving = {
	/**
	 * Whether the client's multi-round-trip driver runs, fulfilling each offer
	 * against the scripted browser and retrying by itself; the answer is then
	 * the last round's.
	 */
	readonly retrying?: boolean;
};

/** Calls a tool, capturing any of the three outcomes as a {@link ToolAnswer}. */
async function answerTo(
	client: Client,
	name: string,
	{ retrying = false }: CallDriving = {},
): Promise<ToolAnswer> {
	try {
		const answer = retrying
			? await callToolThroughRetries(client, name)
			: await callToolAllowingInputRequired(client, name);

		return { ...answer, rejected: false, text: textOf(answer) };
	} catch (error) {
		return { rejected: true, text: String(error) };
	}
}

/**
 * Calls a tool with the multi-round-trip driver off, so an `input_required`
 * answer arrives as itself. The SDK types the result as a finished tool
 * result either way, hence the cast.
 */
async function callToolAllowingInputRequired(
	client: Client,
	name: string,
): Promise<InputRequiredAnswer> {
	return (await client.callTool(
		{ name, arguments: {} },
		{ allowInputRequired: true },
	)) as unknown as InputRequiredAnswer;
}

/**
 * Calls a tool with the multi-round-trip driver on, so an offer is fulfilled
 * and the call retried without the test driving either.
 */
async function callToolThroughRetries(
	client: Client,
	name: string,
): Promise<InputRequiredAnswer> {
	return (await client.callTool({
		name,
		arguments: {},
	})) as unknown as InputRequiredAnswer;
}

/** The page the browser was left on. */
type BrowserPage = { readonly status: number; readonly body: string };

/** Whether the loopback port can be bound right now. Binds and releases. */
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
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** One login, driven end to end by the client's own retry machinery. */
type ElicitedLogin = {
	/** What `get_profile` finally answered. */
	readonly result: CallToolResult;
	readonly whoop: FakeWhoop;
	readonly store: string;
	readonly redirectUri: string;
	/** Every URL this client was asked to open, in order. */
	readonly elicited: ElicitedUrl[];
	/** What each of those URLs left the browser looking at. */
	readonly pages: BrowserPage[];
	/**
	 * Whether the redirect port could be re-bound while the server still ran —
	 * checked then, because it would come back anyway once the process exits.
	 */
	readonly portFreed: boolean;
};

/**
 * Calls `get_profile` against a server with no stored login and lets the
 * client's own retry machinery drive the whole login: the scripted browser
 * follows the consent link through the redirect, and the call is retried.
 *
 * `answering` is what the client reports after its browser went all the way
 * through. With a refusal the login still completed out of band — accept
 * never meant complete.
 */
async function loginThroughElicitation(
	answering: ElicitedAction = "accept",
): Promise<ElicitedLogin> {
	const whoop = await startFakeWhoop();
	const store = await temporaryStore();
	const redirectUri = await unusedRedirectUri();
	const elicited: ElicitedUrl[] = [];
	const pages: BrowserPage[] = [];

	const { result, portFreed } = await withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			credentials: APP,
			redirectUri,
			urlElicitation: {
				browser: async (elicitation): Promise<ElicitedAction> => {
					elicited.push(elicitation);
					// fetch follows WHOOP's redirect back to the loopback listener.
					const page = await fetch(elicitation.url);
					pages.push({ status: page.status, body: await page.text() });

					return answering;
				},
			},
		},
		async (client) => ({
			result: await client.callTool({ name: "get_profile", arguments: {} }),
			portFreed: await portFreedWithin(
				Number(new URL(redirectUri).port),
				5_000,
			),
		}),
	);

	return { result, whoop, store, redirectUri, elicited, pages, portFreed };
}

/** Every request the stand-in WHOOP served at one of its paths. */
function requestsTo(whoop: FakeWhoop, path: string): WhoopRequest[] {
	return whoop.requests.filter((request) => request.path === path);
}

/** The authorize URL an offer sends the user to. */
function elicitedAuthorizeUrl(answer: InputRequiredAnswer): URL {
	return new URL(String(answer.inputRequests?.whoop_login?.params.url));
}

/** The OAuth `state` an offer's authorize URL was minted with. */
function issuedState(answer: InputRequiredAnswer): string {
	return elicitedAuthorizeUrl(answer).searchParams.get("state") ?? "";
}

describe("a tool call with no stored WHOOP login, over real stdio", () => {
	it("answers input_required carrying a URL-mode whoop_login elicitation for WHOOP's authorize endpoint", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();

		const answer = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
			},
			(client) => callToolAllowingInputRequired(client, "get_profile"),
		);

		// Not a tool error: the call is unfinished, not failed.
		expect(answer.isError).not.toBe(true);
		expect(answer.resultType).toBe("input_required");
		expect(Object.keys(answer.inputRequests ?? {})).toEqual(["whoop_login"]);

		const elicitation = answer.inputRequests?.whoop_login;
		expect(elicitation?.method).toBe("elicitation/create");
		expect(elicitation?.params.mode).toBe("url");

		const authorizeUrl = elicitedAuthorizeUrl(answer);
		expect(authorizeUrl.origin).toBe(new URL(whoop.baseUrl).origin);
		expect(authorizeUrl.pathname).toBe("/oauth/oauth2/auth");
		expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizeUrl.searchParams.get("client_id")).toBe(APP.clientId);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(authorizeUrl.searchParams.get("scope")?.split(" ")).toEqual([
			...DEFAULT_READ_SCOPES,
			OFFLINE_SCOPE,
		]);
		expect(authorizeUrl.searchParams.get("state")).toMatch(/\S{16,}/);

		// The attempt is named by something the client only echoes back.
		expect(answer.requestState).toMatch(/\S{16,}/);
	});

	it("answers the browser and exchanges its code as this app once consent is played out", async () => {
		const { whoop, pages, redirectUri } = await loginThroughElicitation();

		expect(pages).toHaveLength(1);
		expect(pages[0]?.status).toBe(200);
		expect(pages[0]?.body).toMatch(/login complete/i);

		const exchanges = requestsTo(whoop, "/oauth/oauth2/token");
		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]?.method).toBe("POST");
		expect(Object.fromEntries(exchanges[0]?.form ?? [])).toMatchObject({
			grant_type: "authorization_code",
			code: AUTHORIZATION_CODE,
			client_id: APP.clientId,
			client_secret: APP.clientSecret,
			redirect_uri: redirectUri,
		});
	});

	it("answers the retry with get_profile's real structured content", async () => {
		const { result, whoop } = await loginThroughElicitation();

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);
		expect(requestsTo(whoop, "/developer/v2/user/profile/basic")).toHaveLength(
			1,
		);
	});

	it("leaves the tokens, the granted scopes and the app that earned them in the store", async () => {
		const { store } = await loginThroughElicitation();

		// The application rides along because WHOOP re-authenticates it on every
		// refresh (ADR 0003).
		expect(
			JSON.parse(await readFile(join(store, "tokens.json"), "utf8")),
		).toMatchObject({
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: expect.any(Number),
			scopes: GRANTED_SCOPES,
			application: {
				clientId: APP.clientId,
				clientSecret: APP.clientSecret,
			},
		});
	});

	it("records the redirect URI it borrowed the port of beside that application", async () => {
		const { store, redirectUri } = await loginThroughElicitation();

		expect(
			(
				JSON.parse(await readFile(join(store, "tokens.json"), "utf8")) as {
					application?: Record<string, unknown>;
				}
			).application,
		).toMatchObject({
			clientId: APP.clientId,
			clientSecret: APP.clientSecret,
			redirectUri,
		});
	});

	it("is already listening for the redirect by the time the offer arrives", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();

		const page = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: {},
			},
			async (client) => {
				const answer = await callToolAllowingInputRequired(
					client,
					"get_profile",
				);
				// Simulate a browser arriving immediately after the offer; a port
				// bound only after the answer went out would refuse it.
				const back = new URL(redirectUri);
				back.searchParams.set("code", AUTHORIZATION_CODE);
				back.searchParams.set("state", issuedState(answer));
				const response = await fetch(back);

				return { status: response.status, body: await response.text() };
			},
		);

		expect(page.status).toBe(200);
		expect(page.body).toMatch(/login complete/i);
	});

	it("gives the redirect port back, having minted one authorize URL for the attempt", async () => {
		const { portFreed, elicited, whoop } = await loginThroughElicitation();

		expect(portFreed).toBe(true);
		// The retry was served from the store rather than starting a second
		// attempt.
		expect(elicited).toHaveLength(1);
		expect(requestsTo(whoop, "/oauth/oauth2/auth")).toHaveLength(1);
	});
});

/** How a client that cannot be shown a consent link is declared. */
type IncapableClient = Pick<
	BuiltStdioClientOptions,
	"elicitation" | "protocolVersion"
>;

/**
 * Clients a consent link must never be offered to — whole client shapes, not
 * capabilities alone, because "can this be offered" is answered from what the
 * client declared on the revision it declared it under.
 */
const CANNOT_BE_OFFERED = {
	/** The current revision, saying nothing at all about elicitation. */
	"declaring no elicitation capability": {},
	/** The bare declaration the specification reads as form mode only. */
	"declaring a bare, form-only elicitation capability": { elicitation: "form" },
	/** The previous revision: capabilities at initialize, none per request. */
	"pinned to the previous protocol revision": {
		protocolVersion: "legacy",
		elicitation: "url",
	},
} as const satisfies Record<string, IncapableClient>;

/** What one such call answered, and what it left behind while answering. */
type RefusedOffer = {
	readonly answer: ToolAnswer;
	/** Which era the connection was actually served on. */
	readonly era: string | undefined;
	/** Whether the redirect URI's port was never taken while the server ran. */
	readonly portFree: boolean;
	readonly whoop: FakeWhoop;
	/** Every elicitation this client was asked for, in order. */
	readonly elicited: ElicitedUrl[];
};

/**
 * Calls `get_profile` against a server with no stored login, from a client
 * that cannot be offered a consent link. Clients declaring any elicitation
 * capability also get a browser script, so an elicitation that arrives
 * anyway is recorded — on the legacy revision that would be the SDK's shim
 * pushing one, which must never happen.
 */
async function callWithoutOffer(
	client: IncapableClient,
): Promise<RefusedOffer> {
	const whoop = await startFakeWhoop();
	const store = await temporaryStore();
	const redirectUri = await unusedRedirectUri();
	const elicited: ElicitedUrl[] = [];

	const { answer, era, portFree } = await withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			credentials: APP,
			redirectUri,
			...client,
			...(client.elicitation === undefined
				? {}
				: {
						urlElicitation: {
							browser: (elicitation): ElicitedAction => {
								elicited.push(elicitation);

								return "decline";
							},
						},
					}),
		},
		async (connected) => ({
			answer: await answerTo(connected, "get_profile"),
			era: connected.getProtocolEra(),
			// Checked while the server still runs; the port would come back
			// anyway once the process exits.
			portFree: await bindable(Number(new URL(redirectUri).port)),
		}),
	);

	return { answer, era, portFree, whoop, elicited };
}

describe("a tool call with no stored WHOOP login, from a client that cannot open a URL", () => {
	it("answers a client declaring no elicitation capability with the prose login error", async () => {
		const { answer } = await callWithoutOffer(
			CANNOT_BE_OFFERED["declaring no elicitation capability"],
		);

		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("npx mcp-whoop login");
	});

	it("answers a client declaring bare, form-only elicitation with the same prose login error", async () => {
		const { answer } = await callWithoutOffer(
			CANNOT_BE_OFFERED["declaring a bare, form-only elicitation capability"],
		);

		// Credentials may not be elicited in form mode, so form-only clients get
		// no offer.
		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("npx mcp-whoop login");
	});

	it("answers a client on the previous protocol revision with the same prose login error, never engaging the SDK's legacy shim", async () => {
		const { answer, era, elicited } = await callWithoutOffer(
			CANNOT_BE_OFFERED["pinned to the previous protocol revision"],
		);

		expect(era).toBe("legacy");
		// An offer toward this revision would not fail — the SDK would push an
		// elicitation — so none arriving is the real check.
		expect(elicited).toEqual([]);
		expect(answer.resultType).not.toBe("input_required");
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("npx mcp-whoop login");
	});

	it("binds no redirect listener and leaves WHOOP untouched for any of them", async () => {
		const refusals: RefusedOffer[] = [];
		for (const client of Object.values(CANNOT_BE_OFFERED)) {
			refusals.push(await callWithoutOffer(client));
		}

		expect(refusals.map((refusal) => refusal.portFree)).toEqual([
			true,
			true,
			true,
		]);
		expect(refusals.flatMap((refusal) => refusal.whoop.requests)).toEqual([]);
	});

	it("fails any of them as an ordinary tool error, with no protocol error on the wire", async () => {
		const refusals: RefusedOffer[] = [];
		for (const client of Object.values(CANNOT_BE_OFFERED)) {
			refusals.push(await callWithoutOffer(client));
		}

		// Offering against a missing capability would answer -32021 — a rejected
		// call, not a failed tool.
		expect(refusals.map((refusal) => refusal.answer.rejected)).toEqual([
			false,
			false,
			false,
		]);
		expect(refusals.map((refusal) => refusal.answer.isError)).toEqual([
			true,
			true,
			true,
		]);
	});
});

/** The two answers that end an offer instead of carrying it forward. */
const REFUSALS = [
	"decline",
	"cancel",
] as const satisfies readonly ElicitedAction[];

/** One offer whose user would not go to WHOOP, and what it left behind. */
type RefusedLogin = {
	readonly answer: ToolAnswer;
	readonly whoop: FakeWhoop;
	readonly store: string;
	/** Every URL this client was asked to open, in order. */
	readonly elicited: ElicitedUrl[];
	/**
	 * Whether the redirect port could be re-bound while the server still ran —
	 * checked then, because it would come back anyway once the process exits.
	 */
	readonly portFreed: boolean;
};

/**
 * Calls `get_profile` against a server with no stored login and has the
 * scripted browser refuse the consent link without opening it, so WHOOP sees
 * nothing and no redirect ever arrives.
 */
async function refuseElicitedLogin(
	action: ElicitedAction,
): Promise<RefusedLogin> {
	const whoop = await startFakeWhoop();
	const store = await temporaryStore();
	const redirectUri = await unusedRedirectUri();
	const elicited: ElicitedUrl[] = [];

	const { answer, portFreed } = await withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			credentials: APP,
			redirectUri,
			urlElicitation: {
				browser: (elicitation): ElicitedAction => {
					elicited.push(elicitation);

					return action;
				},
			},
		},
		async (client) => ({
			answer: await answerTo(client, "get_profile", { retrying: true }),
			portFreed: await portFreedWithin(
				Number(new URL(redirectUri).port),
				5_000,
			),
		}),
	);

	return { answer, whoop, store, elicited, portFreed };
}

describe("a tool call whose WHOOP consent link is refused, over real stdio", () => {
	it("a retry declining the whoop_login elicitation answers the prose login error and closes the listener", async () => {
		const { answer, elicited, portFreed } =
			await refuseElicitedLogin("decline");

		// Re-offering in answer to a refusal would loop; the call must finish.
		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(elicited).toHaveLength(1);
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("npx mcp-whoop login");
		expect(portFreed).toBe(true);
	});

	it("answers a retry cancelling the whoop_login elicitation the same way", async () => {
		const { answer, elicited, portFreed } = await refuseElicitedLogin("cancel");

		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(elicited).toHaveLength(1);
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("npx mcp-whoop login");
		expect(portFreed).toBe(true);
	});

	it("gives the redirect port back and trades no code with WHOOP for either refusal", async () => {
		const refusals: RefusedLogin[] = [];
		for (const action of REFUSALS) {
			refusals.push(await refuseElicitedLogin(action));
		}

		expect(refusals.map((refusal) => refusal.portFreed)).toEqual([true, true]);
		expect(refusals.flatMap((refusal) => refusal.whoop.requests)).toEqual([]);
	});

	it("leaves the token store as absent as it found it for either refusal", async () => {
		const refusals: RefusedLogin[] = [];
		for (const action of REFUSALS) {
			refusals.push(await refuseElicitedLogin(action));
		}

		expect(
			refusals.map((refusal) => existsSync(join(refusal.store, "tokens.json"))),
		).toEqual([false, false]);
	});

	it("serves the data anyway when the decline lands after the browser has finished the login", async () => {
		const { result, whoop } = await loginThroughElicitation("decline");

		// The store, not the client's report, decides: the browser completed the
		// login before the decline arrived.
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);
		expect(requestsTo(whoop, "/developer/v2/user/profile/basic")).toHaveLength(
			1,
		);
	});
});

/** What a serving environment says about the WHOOP application, if anything. */
type ServingEnvironment = Pick<
	BuiltStdioClientOptions,
	"credentials" | "redirectUri"
>;

/**
 * A non-loopback redirect URI carrying a port that is free locally, so a
 * listener bound despite the hostname would show up as a taken port.
 */
async function nonLoopbackRedirectUri(): Promise<string> {
	const elsewhere = new URL(await unusedRedirectUri());
	elsewhere.hostname = "redirect.example.com";

	return elsewhere.href;
}

/**
 * Serving environments that cannot carry a consent link to its end. Built
 * rather than declared: two of them need real loopback ports.
 */
async function unfinishableEnvironments(): Promise<ServingEnvironment[]> {
	return [
		{},
		{ credentials: APP },
		{ credentials: APP, redirectUri: await nonLoopbackRedirectUri() },
		{
			credentials: APP,
			redirectUri: `${await heldByAnotherProcess()}/callback`,
		},
	];
}

/** What the process already holding a loopback port answers with. */
const HOLDER_ANSWER = "still here";

/** A loopback origin another server holds for the whole test. */
async function heldByAnotherProcess(): Promise<string> {
	return listenOnLoopback(
		createServer((_request, response) => {
			response
				.writeHead(200, { "content-type": "text/plain", connection: "close" })
				.end(HOLDER_ANSWER);
		}),
	);
}

/** What one such call answered, and what it left behind while answering. */
type UnfinishableLogin = {
	readonly answer: ToolAnswer;
	readonly whoop: FakeWhoop;
	/** Every elicitation this client was asked for, in order. */
	readonly elicited: ElicitedUrl[];
	/**
	 * Whether the redirect port stayed unbound while the server ran; undefined
	 * when the environment named no redirect URI with a port to check.
	 */
	readonly redirectPortFree: boolean | undefined;
};

/**
 * Calls `get_profile` with no stored login, from a capable client, in an
 * environment that cannot finish a login. The browser is scripted to record
 * and follow any link offered anyway, which would put WHOOP's consent screen
 * on the record.
 */
async function callWithoutFinishableLogin(
	environment: ServingEnvironment,
	driving: CallDriving = {},
): Promise<UnfinishableLogin> {
	const whoop = await startFakeWhoop();
	const store = await temporaryStore();
	const elicited: ElicitedUrl[] = [];

	const { answer, redirectPortFree } = await withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			...environment,
			urlElicitation: {
				browser: async (elicitation): Promise<ElicitedAction> => {
					elicited.push(elicitation);
					await fetch(elicitation.url).catch(() => undefined);

					return "decline";
				},
			},
		},
		async (client) => ({
			answer: await answerTo(client, "get_profile", driving),
			redirectPortFree: await redirectPortStillFree(environment.redirectUri),
		}),
	);

	return { answer, whoop, elicited, redirectPortFree };
}

/**
 * Whether the port a redirect URI names is still unbound — undefined without
 * a parseable port to check.
 */
async function redirectPortStillFree(
	redirectUri: string | undefined,
): Promise<boolean | undefined> {
	const port =
		redirectUri === undefined ? undefined : URL.parse(redirectUri)?.port;

	return port === undefined ? undefined : bindable(Number(port));
}

describe("a tool call whose serving environment cannot finish a login", () => {
	it("names every missing variable beside the login command when no WHOOP application is described", async () => {
		const { answer } = await callWithoutFinishableLogin({});

		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("\n  - WHOOP_CLIENT_ID");
		expect(answer.text).toContain("\n  - WHOOP_CLIENT_SECRET");
		expect(answer.text).toContain("\n  - WHOOP_REDIRECT_URI");
		expect(answer.text).toContain("npx mcp-whoop login");
	});

	it("names the redirect URI alone when that is the only variable missing", async () => {
		const { answer } = await callWithoutFinishableLogin({ credentials: APP });

		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("an environment variable is missing");
		expect(answer.text).toContain("\n  - WHOOP_REDIRECT_URI");
		expect(answer.text).not.toContain("WHOOP_CLIENT_ID");
		expect(answer.text).not.toContain("WHOOP_CLIENT_SECRET");
		expect(answer.text).toContain("npx mcp-whoop login");
	});

	it("says the redirect URI is not loopback, and binds nothing, when it points elsewhere", async () => {
		const redirectUri = await nonLoopbackRedirectUri();

		const { answer, redirectPortFree } = await callWithoutFinishableLogin({
			credentials: APP,
			redirectUri,
		});

		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("not an http:// loopback address");
		expect(answer.text).toContain(redirectUri);
		expect(answer.text).toContain("npx mcp-whoop login");
		// The URI is judged before any port is bound.
		expect(redirectPortFree).toBe(true);
	});

	it("names the redirect URI variable, and offers nothing, when it is not a URL at all", async () => {
		const { answer, elicited } = await callWithoutFinishableLogin({
			credentials: APP,
			redirectUri: "not a url",
		});

		// An unparseable value deliberately does not stop the server at startup
		// (`src/config/environment.ts`), so it must be reported here instead.
		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("WHOOP_REDIRECT_URI");
		expect(answer.text).toContain("npx mcp-whoop login");
		expect(elicited).toEqual([]);
	});

	it("says the redirect port is taken, and leaves its holder serving, when another process has it", async () => {
		const redirectUri = `${await heldByAnotherProcess()}/callback`;

		const { answer } = await callWithoutFinishableLogin({
			credentials: APP,
			redirectUri,
		});

		expect(answer.resultType).not.toBe("input_required");
		expect(answer.inputRequests).toBeUndefined();
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("already in use");
		expect(answer.text).toContain(redirectUri);
		expect(answer.text).toContain("npx mcp-whoop login");
		// The holder still answers: a refused bind takes nothing from it.
		expect(await (await fetch(redirectUri)).text()).toBe(HOLDER_ANSWER);
	});

	it("asks WHOOP for nothing at all in any of them", async () => {
		const calls: UnfinishableLogin[] = [];
		for (const environment of await unfinishableEnvironments()) {
			// retrying would drive any offered link all the way to WHOOP and back.
			calls.push(
				await callWithoutFinishableLogin(environment, { retrying: true }),
			);
		}

		expect(calls.flatMap((call) => call.elicited)).toEqual([]);
		expect(calls.flatMap((call) => call.whoop.requests)).toEqual([]);
	});
});

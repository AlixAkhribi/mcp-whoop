import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	readStoredTokens,
	type StoredTokens,
	writeStoredTokens,
} from "@/whoop/auth/tokens/store";

import {
	type BuiltStdioClientOptions,
	type ElicitedAction,
	type ElicitedUrl,
	listenOnLoopback,
	temporaryStore,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The resource these cases read: one fixed URI, picked whole. */
const PROFILE_URI = "whoop://profile";

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
const GRANTED_SCOPES = ["read:profile", "offline"];

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
 * redirects the browser back with a code, the token endpoint trades that code
 * for tokens, and the data endpoint serves the profile.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
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
				form,
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

			// This WHOOP honours no refresh token: every stored login it is shown
			// is one it has stopped renewing.
			if (
				arrived.pathname === "/oauth/oauth2/token" &&
				form.get("grant_type") === "refresh_token"
			) {
				response
					.writeHead(400, {
						"content-type": "application/json",
						connection: "close",
					})
					.end(JSON.stringify({ error: "invalid_grant" }));

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

/**
 * What a `resources/read` came back as: either the contents of the resource,
 * or the unfinished answer offering a way to earn them.
 */
type ReadAnswer = {
	readonly resultType?: string;
	readonly requestState?: string;
	readonly inputRequests?: Record<
		string,
		{ readonly method: string; readonly params: Record<string, unknown> }
	>;
	readonly contents?: readonly {
		readonly uri: string;
		readonly text?: string;
	}[];
};

/**
 * Reads a resource with the client's multi-round-trip driver off, so an
 * `input_required` answer arrives as itself. The SDK types the result as a
 * finished read either way, hence the cast.
 */
async function readAllowingInputRequired(
	client: Client,
	uri: string,
): Promise<ReadAnswer> {
	return (await client.readResource(
		{ uri },
		{ allowInputRequired: true },
	)) as unknown as ReadAnswer;
}

/** The authorize URL an offer sends the user to. */
function elicitedAuthorizeUrl(answer: ReadAnswer): URL {
	return new URL(String(answer.inputRequests?.whoop_login?.params.url));
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

/** The tokens the store holds now, read from outside the serving process. */
function storedNow(store: string): Promise<StoredTokens | undefined> {
	return readStoredTokens({ env: { WHOOP_TOKEN_STORE: store } });
}

/**
 * A browser that opens the consent link and consents: `fetch` follows WHOOP's
 * redirect back to the loopback listener, which is what completes the login.
 * Every link it was shown is recorded in `elicited`.
 */
function consenting(
	elicited: ElicitedUrl[],
): (elicitation: ElicitedUrl) => Promise<ElicitedAction> {
	return async (elicitation) => {
		elicited.push(elicitation);
		await fetch(elicitation.url);

		return "accept";
	};
}

describe("a resource read with no stored WHOOP login, over real stdio", () => {
	it("offers WHOOP's consent link when a resource is read with no login on a client that opens links", async () => {
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
			(client) => readAllowingInputRequired(client, PROFILE_URI),
		);

		// Not a refusal: the read is unfinished, not failed.
		expect(answer.resultType).toBe("input_required");
		expect(Object.keys(answer.inputRequests ?? {})).toEqual(["whoop_login"]);

		const elicitation = answer.inputRequests?.whoop_login;
		expect(elicitation?.method).toBe("elicitation/create");
		expect(elicitation?.params.mode).toBe("url");

		const authorizeUrl = elicitedAuthorizeUrl(answer);
		expect(authorizeUrl.origin).toBe(new URL(whoop.baseUrl).origin);
		expect(authorizeUrl.pathname).toBe("/oauth/oauth2/auth");
		expect(authorizeUrl.searchParams.get("client_id")).toBe(APP.clientId);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);

		// The attempt is named by something the client only echoes back.
		expect(answer.requestState).toMatch(/\S{16,}/);
	});

	it("answers the resource once the browser has consented, leaving the granted tokens in the store", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();
		const elicited: ElicitedUrl[] = [];

		const read = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri,
				urlElicitation: { browser: consenting(elicited) },
			},
			// The driver fulfils the offer against the scripted browser and
			// retries by itself, so the whole login happens inside one read.
			(client) => client.readResource({ uri: PROFILE_URI }),
		);

		expect(elicited).toHaveLength(1);
		expect(read.contents).toHaveLength(1);
		expect(read.contents[0]).toMatchObject({
			uri: PROFILE_URI,
			mimeType: "application/json",
		});
		expect(JSON.parse(textOf(read.contents[0]))).toEqual(PROFILE);

		// The application rides along because WHOOP re-authenticates it on every
		// refresh.
		expect(await storedNow(store)).toMatchObject({
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			scopes: GRANTED_SCOPES,
			application: {
				clientId: APP.clientId,
				clientSecret: APP.clientSecret,
				redirectUri,
			},
		});
	});
});

/** How a client that cannot be shown a consent link is declared. */
type IncapableClient = Pick<
	BuiltStdioClientOptions,
	"elicitation" | "protocolVersion"
>;

/** The JSON-RPC error a refused read comes back as. */
type Refusal = { code: number; message: string };

/** What a retry round may carry beside the resource URI. */
type RetryRound = {
	readonly requestState?: string;
	readonly inputResponses?: Record<string, unknown>;
};

type ReadResourceParams = Parameters<Client["readResource"]>[0];

/**
 * Reads a resource that is meant to fail, and reduces the rejection to the
 * JSON-RPC error the client was answered with. A read that is answered instead
 * fails here on its premise rather than on a later expectation.
 */
async function readExpectingRefusal(
	client: Client,
	uri: string,
	retry: RetryRound = {},
): Promise<Refusal> {
	try {
		await client.readResource({ uri, ...retry } as ReadResourceParams);
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(`reading ${uri} was answered rather than refused`);
}

/**
 * Reads `whoop://profile` with no stored login, from a client that may not be
 * offered a consent link. Any elicitation that arrives anyway is recorded — on
 * the legacy revision that would be the SDK's shim pushing one, which must
 * never happen.
 */
async function refusedRead(
	client: IncapableClient,
): Promise<{ refusal: Refusal; elicited: ElicitedUrl[]; era?: string }> {
	const whoop = await startFakeWhoop();
	const store = await temporaryStore();
	const elicited: ElicitedUrl[] = [];

	return withBuiltStdioClient(
		{
			store,
			whoopBaseUrl: whoop.baseUrl,
			credentials: APP,
			redirectUri: await unusedRedirectUri(),
			...client,
			urlElicitation: { browser: consenting(elicited) },
		},
		async (connected) => ({
			refusal: await readExpectingRefusal(connected, PROFILE_URI),
			elicited,
			era: connected.getProtocolEra(),
		}),
	);
}

describe("a resource read with no login, from a client that cannot open a URL", () => {
	it("refuses a client declaring bare, form-only elicitation with the prose naming the login command", async () => {
		const { refusal, elicited } = await refusedRead({ elicitation: "form" });

		// Credentials may not be elicited in form mode, so a form-only client is
		// offered nothing: the read fails as the internal error it always was.
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("npx mcp-whoop login");
		expect(elicited).toEqual([]);
	});

	it("refuses a client on the previous protocol revision the same way, never engaging the SDK's legacy shim", async () => {
		const { refusal, elicited, era } = await refusedRead({
			protocolVersion: "legacy",
			elicitation: "url",
		});

		expect(era).toBe("legacy");
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("npx mcp-whoop login");
		// An offer toward this revision would not fail — the SDK would push an
		// elicitation — so none arriving is the real check.
		expect(elicited).toEqual([]);
	});
});

describe("a WHOOP consent link a resource read's user declined", () => {
	it("makes no second offer to a later read of that process, refusing it in prose", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const elicited: ElicitedUrl[] = [];

		const { declined, next } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri: await unusedRedirectUri(),
				urlElicitation: {
					browser: (elicitation): ElicitedAction => {
						elicited.push(elicitation);

						return "decline";
					},
				},
			},
			async (client) => ({
				// The driver puts the link in front of the browser and carries the
				// decline back on the retry, which is the round that refuses.
				declined: await readExpectingRefusal(client, PROFILE_URI),
				next: await readExpectingRefusal(client, PROFILE_URI),
			}),
		);

		expect(declined.code).toBe(-32603);
		expect(declined.message).toContain("npx mcp-whoop login");

		// A user who said no is not asked again for the life of this process:
		// the second read is refused in prose, having offered nothing.
		expect(elicited).toHaveLength(1);
		expect(next.code).toBe(-32603);
		expect(next.message).toContain("npx mcp-whoop login");
		// The link was never opened, so WHOOP saw nothing of either read.
		expect(whoop.requests).toEqual([]);
	});
});

/** A `requestState` naming an attempt this server never started. */
const NEVER_MINTED = "a-request-state-this-server-never-minted";

describe("a WHOOP consent link declined under a fabricated request state", () => {
	it("refuses that resource read in prose but still offers the next read a consent link", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { forged, next } = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri: await unusedRedirectUri(),
				urlElicitation: {},
			},
			async (client) => ({
				forged: await readExpectingRefusal(client, PROFILE_URI, {
					requestState: NEVER_MINTED,
					inputResponses: { whoop_login: { action: "decline" } },
				}),
				// A state this process never minted decided nothing about later offers.
				next: await readAllowingInputRequired(client, PROFILE_URI),
			}),
		);

		expect(forged.code).toBe(-32603);
		expect(forged.message).toContain("npx mcp-whoop login");
		expect(next.resultType).toBe("input_required");
		expect(Object.keys(next.inputRequests ?? {})).toEqual(["whoop_login"]);
		expect(next.requestState).toMatch(/\S{16,}/);
		expect(next.requestState).not.toBe(NEVER_MINTED);
	});
});

/**
 * The application a login recorded beside its tokens. These cases spawn the
 * server with no WHOOP environment of its own — the documented MCP client
 * configuration — so the store is all a re-login has to go on.
 */
const STORED_APPLICATION = {
	clientId: "stored-client-id",
	clientSecret: "stored-client-secret",
} as const;

/**
 * Seeds a login WHOOP will not renew: the access token is already spent, so
 * the read must refresh, and this stand-in WHOOP honours no refresh token.
 */
async function seedDeadLogin(
	store: string,
	redirectUri: string,
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "expired-access-token",
			refreshToken: "dead-refresh-token",
			expiresAt: Date.now() - 60_000,
			scopes: GRANTED_SCOPES,
			application: { ...STORED_APPLICATION, redirectUri },
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

describe("a resource read whose stored WHOOP login WHOOP will not renew", () => {
	it("offers the consent link the never-logged-in case is offered", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const redirectUri = await unusedRedirectUri();
		await seedDeadLogin(store, redirectUri);

		const answer = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl, urlElicitation: {} },
			(client) => readAllowingInputRequired(client, PROFILE_URI),
		);

		expect(answer.resultType).toBe("input_required");
		expect(Object.keys(answer.inputRequests ?? {})).toEqual(["whoop_login"]);
		expect(answer.inputRequests?.whoop_login?.params.mode).toBe("url");

		// The link can only have come from what the store recorded: this process
		// carries no WHOOP environment of its own.
		const authorizeUrl = elicitedAuthorizeUrl(answer);
		expect(authorizeUrl.origin).toBe(new URL(whoop.baseUrl).origin);
		expect(authorizeUrl.pathname).toBe("/oauth/oauth2/auth");
		expect(authorizeUrl.searchParams.get("client_id")).toBe(
			STORED_APPLICATION.clientId,
		);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);

		// The dead-login path, not the never-logged-in one: WHOOP was asked to
		// renew the stored login and refused.
		expect(
			whoop.requests.filter(
				(request) => request.form.get("grant_type") === "refresh_token",
			).length,
		).toBeGreaterThanOrEqual(1);
	});
});

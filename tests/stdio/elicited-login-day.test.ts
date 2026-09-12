import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	buildCycle,
	buildRecovery,
	buildSleep,
} from "../fixtures/whoop-records";
import {
	callToolOutcome,
	type ElicitedAction,
	type ElicitedUrl,
	listenOnLoopback,
	temporaryStore,
	unusedRedirectUri,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The wake day these cases read: the morning of 2026-08-04. */
const DAY = "2026-08-04";

/** The member of the day family these cases ask for. */
const DAY_URI = `whoop://day/${DAY}`;

/** The application the serving environment describes in these cases. */
const APP = {
	clientId: "a-client-id",
	clientSecret: "a-client-secret",
} as const;

/** The code the stand-in WHOOP's consent screen sends the browser back with. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** What the stand-in WHOOP grants: enough to read a day, plus renewal. */
const GRANTED_SCOPES = [
	"read:cycles",
	"read:recovery",
	"read:sleep",
	"offline",
];

/** The day the stand-in WHOOP holds: one closed cycle, its night, its score. */
const CYCLE = buildCycle({ day: DAY });
const SLEEP = buildSleep({ id: `sleep-${DAY}`, day: DAY });
const RECOVERY = buildRecovery({ day: DAY });

/** One request the stand-in WHOOP was asked to serve. */
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
 * A stand-in WHOOP covering the whole consent flow and one day: the authorize
 * endpoint redirects the browser back with a code, the token endpoint trades
 * that code for tokens, and the collections serve the records the 4th names.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const arrived = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			requests.push({ method: request.method ?? "", path: arrived.pathname });

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
					: arrived.pathname === "/developer/v2/cycle"
						? { records: [CYCLE], next_token: null }
						: arrived.pathname === "/developer/v2/activity/sleep"
							? { records: [SLEEP], next_token: null }
							: arrived.pathname === `/developer/v2/cycle/${CYCLE.id}/recovery`
								? RECOVERY
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

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
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

describe("a day read with no stored WHOOP login, over real stdio", () => {
	it("offers the consent link on a day read too", async () => {
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
			(client) => readAllowingInputRequired(client, DAY_URI),
		);

		// Not a refusal: a member of the family is read under the same offer a
		// fixed resource is read under — unfinished, carrying WHOOP's consent URL.
		expect(answer.resultType).toBe("input_required");
		expect(Object.keys(answer.inputRequests ?? {})).toEqual(["whoop_login"]);

		const elicitation = answer.inputRequests?.whoop_login;
		expect(elicitation?.method).toBe("elicitation/create");
		expect(elicitation?.params.mode).toBe("url");

		const authorizeUrl = new URL(String(elicitation?.params.url));
		expect(authorizeUrl.origin).toBe(new URL(whoop.baseUrl).origin);
		expect(authorizeUrl.pathname).toBe("/oauth/oauth2/auth");
		expect(authorizeUrl.searchParams.get("client_id")).toBe(APP.clientId);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);

		// The attempt is named by something the client only echoes back.
		expect(answer.requestState).toMatch(/\S{16,}/);
	});

	it("answers the day once the browser has consented", async () => {
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
			(client) => client.readResource({ uri: DAY_URI }),
		);

		expect(elicited).toHaveLength(1);
		expect(read.contents).toHaveLength(1);
		expect(read.contents[0]).toMatchObject({
			uri: DAY_URI,
			mimeType: "application/json",
		});
		// The snapshot itself, whole: the day the login just earned the right to
		// read, in the same shape every other surface answers it.
		expect(JSON.parse(textOf(read.contents[0]))).toEqual({
			cycle: CYCLE,
			recovery_state: "SCORED",
			recovery: RECOVERY,
			sleep: SLEEP,
		});
	});
});

/** The JSON-RPC error a refused read comes back as. */
type Refusal = { code: number; message: string; data?: unknown };

/**
 * Reads a resource that is meant to fail, and reduces the rejection to the
 * JSON-RPC error the client was answered with. A read that is answered instead
 * fails here on its premise rather than on a later expectation.
 */
async function readExpectingRefusal(
	client: Client,
	uri: string,
): Promise<Refusal> {
	try {
		await client.readResource({ uri });
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(`reading ${uri} was answered rather than refused`);
}

describe("a WHOOP consent link a day read's user declined", () => {
	it("makes no offer to a later tool call of that process, refusing it in prose", async () => {
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
				declined: await readExpectingRefusal(client, DAY_URI),
				// A different surface entirely: a tool call, made as any first one is.
				next: await callToolOutcome(client, "get_profile"),
			}),
		);

		expect(declined.code).toBe(-32603);
		expect(declined.message).toContain("npx mcp-whoop login");

		// One policy over every surface: the no given on a day read stands for the
		// tools too, so the call is refused in prose, having offered nothing.
		expect(elicited).toHaveLength(1);
		expect(next.rejected).toBe(false);
		expect(next.failed).toBe(true);
		expect(next.text).toContain("npx mcp-whoop login");
	});
});

/**
 * A `{date}` that is no date at all: the 45th of the 13th month. Well-formed
 * to the eye and impossible on a calendar — the shape of value that has to be
 * refused before anything else is judged.
 */
const MALFORMED_URI = "whoop://day/2026-13-45";

describe("a malformed day read with no stored WHOOP login, over real stdio", () => {
	it("refuses it as invalid params before any login is judged, offering nothing", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		const elicited: ElicitedUrl[] = [];

		const refusal = await withBuiltStdioClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: APP,
				redirectUri: await unusedRedirectUri(),
				urlElicitation: { browser: consenting(elicited) },
			},
			(client) => readExpectingRefusal(client, MALFORMED_URI),
		);

		// A URI that could never answer is judged on its own terms first: invalid
		// params with the URI echoed in the error data, exactly as a logged-in
		// process refuses it — the missing login never enters into it.
		expect(refusal.code).toBe(-32602);
		expect(refusal.data).toEqual({ uri: MALFORMED_URI });

		// No offer is made for it: a consent screen earns nothing here, so this
		// URL-capable client is shown no link, and WHOOP hears of nothing at all.
		expect(elicited).toEqual([]);
		expect(whoop.requests).toEqual([]);
	});
});

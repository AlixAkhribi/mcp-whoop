/**
 * @file ADR 0003's application precedence between the environment and the
 * store, asked of the two paths that depend on it: the login offered inside a
 * conversation, and the refresh that keeps one alive.
 */

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { refreshTokens } from "@/whoop/api/oauth/token-refresh";
import { resolveApplication } from "@/whoop/auth/application";
import {
	endLoginAttempt,
	type StartedLogin,
	startLoginAttempt,
} from "@/whoop/auth/elicited/attempt";
import {
	readStoredTokens,
	type StoredApplication,
	writeStoredTokens,
} from "@/whoop/auth/tokens/store";

import {
	deferCleanup,
	listenOnLoopback,
	temporaryStore,
	unusedRedirectUri,
} from "../helpers/harness";

/** The application a login recorded beside the tokens it earned. */
const STORED_APP = {
	clientId: "stored-client-id",
	clientSecret: "stored-client-secret",
} as const;

/** The application a serving process carries in its own environment. */
const ENVIRONMENT_APP = {
	WHOOP_CLIENT_ID: "env-client-id",
	WHOOP_CLIENT_SECRET: "env-client-secret",
} as const;

/**
 * A token store holding a live login. Omitting `application` is what a store
 * written before ADR 0003 looks like.
 */
async function storeHolding(application?: StoredApplication): Promise<string> {
	const store = await temporaryStore();
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes: ["read:profile", "offline"],
			...(application && { application }),
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);

	return store;
}

/**
 * The offer a serving process with this environment would make. A started
 * attempt holds a loopback port, so it is ended when the test is over.
 */
async function offerFrom(env: NodeJS.ProcessEnv): Promise<StartedLogin> {
	const started = await startLoginAttempt(env);
	if (started.started) {
		deferCleanup(() => endLoginAttempt(started.attempt.requestState));
	}

	return started;
}

/** The URL an offer sends the browser to; throws with the refusal instead. */
function authorizeUrl(started: StartedLogin): URL {
	if (!started.started) {
		throw new Error(`no offer was made: ${started.unavailable}`);
	}

	return started.attempt.authorizeUrl;
}

/** The code the stand-in WHOOP's consent screen sends the browser back with. */
const AUTHORIZATION_CODE = "an-authorization-code";

/** A stand-in WHOOP, holding every grant its token endpoint was signed with. */
type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** The form body of each token grant it served, in order. */
	readonly grants: URLSearchParams[];
};

/**
 * A stand-in WHOOP that trades any code for tokens and records what each grant
 * was signed with — the only place the resolved client secret is observable,
 * since an authorize URL carries none.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const grants: URLSearchParams[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			grants.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
			response.writeHead(200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(
				JSON.stringify({
					access_token: "a-fresh-access-token",
					refresh_token: "a-fresh-refresh-token",
					expires_in: 3600,
					scope: "read:profile offline",
					token_type: "bearer",
				}),
			);
		});
	});

	return { baseUrl: await listenOnLoopback(server), grants };
}

/**
 * Redirects back to the authorize URL's redirect URI with the code and that
 * URL's state. Resolves once the page is served, which the listener does only
 * after the exchange it triggered has finished.
 */
async function playBrowser(url: URL): Promise<void> {
	const back = new URL(url.searchParams.get("redirect_uri") ?? "");
	back.searchParams.set("code", AUTHORIZATION_CODE);
	back.searchParams.set("state", url.searchParams.get("state") ?? "");
	await (await fetch(back)).text();
}

/** The first grant's form body, as a plain object to assert against. */
function signedWith(whoop: FakeWhoop): Record<string, string> {
	return Object.fromEntries(whoop.grants[0] ?? []);
}

describe("the application a login offer is minted from", () => {
	it("is the one the store recorded when the serving process has no WHOOP environment at all", async () => {
		const redirectUri = await unusedRedirectUri();
		const store = await storeHolding({ ...STORED_APP, redirectUri });

		const url = authorizeUrl(await offerFrom({ WHOOP_TOKEN_STORE: store }));

		// With no WHOOP variables in the environment (ADR 0003), the store is the
		// only source of the application and the address WHOOP may return to.
		expect(url.searchParams.get("client_id")).toBe(STORED_APP.clientId);
		expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
	});

	it("is the environment's, whole, when the environment describes one too", async () => {
		const whoop = await startFakeWhoop();
		const store = await storeHolding({
			...STORED_APP,
			redirectUri: await unusedRedirectUri(),
		});
		const redirectUri = await unusedRedirectUri();

		const url = authorizeUrl(
			await offerFrom({
				WHOOP_TOKEN_STORE: store,
				WHOOP_API_BASE_URL: whoop.baseUrl,
				...ENVIRONMENT_APP,
				WHOOP_REDIRECT_URI: redirectUri,
			}),
		);
		await playBrowser(url);

		// A complete environment pair outranks the stored one (ADR 0003), and does
		// so whole: id, redirect URI and secret are all the environment's.
		expect(url.searchParams.get("client_id")).toBe(
			ENVIRONMENT_APP.WHOOP_CLIENT_ID,
		);
		expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(signedWith(whoop)).toMatchObject({
			client_id: ENVIRONMENT_APP.WHOOP_CLIENT_ID,
			client_secret: ENVIRONMENT_APP.WHOOP_CLIENT_SECRET,
			redirect_uri: redirectUri,
		});
	});

	it("is the store's, whole, when the environment describes only part of one", async () => {
		const whoop = await startFakeWhoop();
		const redirectUri = await unusedRedirectUri();
		const store = await storeHolding({ ...STORED_APP, redirectUri });

		const url = authorizeUrl(
			await offerFrom({
				WHOOP_TOKEN_STORE: store,
				WHOOP_API_BASE_URL: whoop.baseUrl,
				WHOOP_CLIENT_ID: ENVIRONMENT_APP.WHOOP_CLIENT_ID,
			}),
		);
		await playBrowser(url);

		// A partial environment pair contributes nothing (ADR 0003): this id with
		// the store's secret would authenticate as neither application.
		expect(url.searchParams.get("client_id")).toBe(STORED_APP.clientId);
		expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(signedWith(whoop)).toMatchObject({
			client_id: STORED_APP.clientId,
			client_secret: STORED_APP.clientSecret,
			redirect_uri: redirectUri,
		});
	});

	it("is nothing to offer from when the store predates the redirect URI and the environment names none", async () => {
		const whoop = await startFakeWhoop();
		// A store predating the redirect URI: it can still sign a refresh, but
		// cannot say where consent comes back.
		const store = await storeHolding(STORED_APP);

		const started = await offerFrom({
			WHOOP_TOKEN_STORE: store,
			WHOOP_API_BASE_URL: whoop.baseUrl,
		});

		expect(started.started).toBe(false);
		const unavailable = started.started ? "" : started.unavailable;
		// Only the missing variable is named: asking for a client id already on
		// disk would send the reader after the wrong thing.
		expect(unavailable).toContain("an environment variable is missing");
		expect(unavailable).toContain("\n  - WHOOP_REDIRECT_URI");
		expect(unavailable).not.toContain("WHOOP_CLIENT_ID");
		expect(unavailable).not.toContain("WHOOP_CLIENT_SECRET");
		// A terminal login is what records a redirect URI for a store lacking one.
		expect(unavailable).toContain("npx mcp-whoop login");
		// The refusal costs no trip to WHOOP.
		expect(whoop.grants).toEqual([]);
	});

	it("is the environment's when the store cannot be read at all, and the login it starts rewrites that store whole", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await writeFile(join(store, "tokens.json"), "{ this is not a store", {
			encoding: "utf8",
			mode: 0o600,
		});
		const redirectUri = await unusedRedirectUri();
		const env = {
			WHOOP_TOKEN_STORE: store,
			WHOOP_API_BASE_URL: whoop.baseUrl,
			...ENVIRONMENT_APP,
			WHOOP_REDIRECT_URI: redirectUri,
		};

		const url = authorizeUrl(await offerFrom(env));
		await playBrowser(url);

		// The offer stands: minting one needs nothing from the store.
		expect(url.searchParams.get("client_id")).toBe(
			ENVIRONMENT_APP.WHOOP_CLIENT_ID,
		);
		const rewritten = await readStoredTokens({ env });
		expect(rewritten?.accessToken).toBe("a-fresh-access-token");
		expect(rewritten?.application).toEqual({
			clientId: ENVIRONMENT_APP.WHOOP_CLIENT_ID,
			clientSecret: ENVIRONMENT_APP.WHOOP_CLIENT_SECRET,
			redirectUri,
		});
	});
});

/** The redirect URI a login recorded in the store. */
const RECORDED_REDIRECT_URI = "http://127.0.0.1:4711/callback";

/** A different one, named by a serving process's own environment. */
const ENVIRONMENT_REDIRECT_URI = "http://127.0.0.1:4712/callback";

/** A stored login whose access token expired a minute ago. */
function expiredLogin(application: StoredApplication) {
	return {
		accessToken: "a-stale-access-token",
		refreshToken: "a-spent-refresh-token",
		expiresAt: Date.now() - 60_000,
		scopes: ["read:profile", "offline"],
		application,
	};
}

describe("the application a refresh authenticates as", () => {
	it("comes from the same rule the offer is minted from, whatever the environment carries", async () => {
		const whoop = await startFakeWhoop();
		const recorded: StoredApplication = {
			...STORED_APP,
			redirectUri: RECORDED_REDIRECT_URI,
		};
		// The three shapes an environment takes: nothing, the pair alone (a secret
		// rotated in WHOOP's dashboard), and a whole application of its own.
		const environments: NodeJS.ProcessEnv[] = [
			{},
			{ ...ENVIRONMENT_APP },
			{ ...ENVIRONMENT_APP, WHOOP_REDIRECT_URI: ENVIRONMENT_REDIRECT_URI },
		];

		const authenticated: (StoredApplication | undefined)[] = [];
		for (const environment of environments) {
			const rotated = await refreshTokens(expiredLogin(recorded), {
				env: { ...environment, WHOOP_API_BASE_URL: whoop.baseUrl },
			});
			authenticated.push(rotated.application);
		}

		// A refresh must resolve through the same rule as the offer, or the two
		// would disagree about which application this server is.
		expect(authenticated).toEqual(
			environments.map((environment) =>
				resolveApplication(environment, recorded),
			),
		);
		expect(whoop.grants.map((grant) => grant.get("client_id"))).toEqual(
			authenticated.map((app) => app?.clientId),
		);
		expect(whoop.grants.map((grant) => grant.get("client_secret"))).toEqual(
			authenticated.map((app) => app?.clientSecret),
		);
	});
});

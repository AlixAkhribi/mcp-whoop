import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runLogin } from "@/auth/login";

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/**
 * The same promise, but reported as a legible failure when it stalls — a login
 * that never prints or never finishes should name what it was waiting for
 * rather than sit there until the runner gives up.
 */
function within<T>(work: Promise<T>, what: string): Promise<T> {
	return Promise.race([
		work,
		new Promise<T>((_resolve, reject) => {
			setTimeout(() => {
				reject(new Error(`timed out waiting for ${what}`));
			}, 10_000).unref();
		}),
	]);
}

/** Starts a loopback server and reports the origin it ended up on. */
async function listenOnLoopback(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	opened.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	);

	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-login-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/**
 * A redirect URI nothing is listening on yet, so the login command is the one
 * that binds its port.
 */
async function unusedRedirectUri(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});

	return `http://127.0.0.1:${port}/callback`;
}

/** How a stand-in WHOOP answers a request to its token endpoint. */
type TokenReply = { status: number; body: Record<string, unknown> };

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP was asked to exchange a code with. */
	readonly exchanges: { path: string; form: URLSearchParams }[];
};

/**
 * A stand-in WHOOP: the one network seam the login command talks through, so
 * a case can hand out tokens, reject a code, and inspect what was sent.
 */
async function startFakeWhoop(reply: () => TokenReply): Promise<FakeWhoop> {
	const exchanges: { path: string; form: URLSearchParams }[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			exchanges.push({
				path: new URL(request.url ?? "/", "http://whoop.invalid").pathname,
				form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
			});
			const { status, body } = reply();
			response.writeHead(status, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(body));
		});
	});

	return { baseUrl: await listenOnLoopback(server), exchanges };
}

/** A login in progress, with the seams a terminal would own replaced. */
type RunningLogin = {
	/** The authorize URL the command printed, once it has printed one. */
	readonly authorizeUrl: Promise<URL>;
	/** The exit code the command finished with; rejects if it never does. */
	readonly exitCode: Promise<number>;
	/** Every line the command printed. */
	readonly printed: string[];
	/** Every failure the command reported. */
	readonly failures: string[];
};

function startLogin(env: NodeJS.ProcessEnv): RunningLogin {
	const printed: string[] = [];
	const failures: string[] = [];
	let announce: (url: URL) => void = () => {};
	const authorizeUrl = new Promise<URL>((resolve) => {
		announce = resolve;
	});

	const exitCode = runLogin({
		env,
		print: (message) => {
			printed.push(message);
			const found = message.match(/https?:\/\/\S*\/oauth\/oauth2\/auth\S*/);
			if (found) {
				announce(new URL(found[0]));
			}
		},
		printFailure: (message) => {
			failures.push(message);
		},
		openBrowser: () => {},
	});

	return {
		authorizeUrl: within(authorizeUrl, "the authorize URL to be printed"),
		exitCode: within(exitCode, "the login command to finish"),
		printed,
		failures,
	};
}

/** Plays the browser: the redirect back to the loopback callback. */
async function redirectBack(
	redirectUri: string,
	query: Record<string, string>,
): Promise<{ status: number; body: string }> {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(query)) {
		url.searchParams.set(name, value);
	}
	const response = await fetch(url);

	return { status: response.status, body: await response.text() };
}

/** What the token store holds, as it was persisted. */
async function storedTokens(
	directory: string,
): Promise<Record<string, unknown>> {
	return JSON.parse(
		await readFile(join(directory, "tokens.json"), "utf8"),
	) as Record<string, unknown>;
}

/** How a WHOOP that hands out tokens answers the exchange. */
const TOKENS_GRANTED: TokenReply = {
	status: 200,
	body: {
		access_token: "an-access-token",
		refresh_token: "a-refresh-token",
		expires_in: 3600,
		scope: "read:profile read:sleep offline",
		token_type: "bearer",
	},
};

/** What a case may vary on an otherwise working login. */
type LoginScenario = {
	/** Environment on top of a working application's. */
	readonly env?: Record<string, string>;
	/** How the stand-in WHOOP answers the code exchange. */
	readonly reply?: () => TokenReply;
	/** What the browser carries back, given where it was sent. */
	readonly redirect?: (authorizeUrl: URL) => Record<string, string>;
};

/** A login run from the printed URL to the exit code, with what it left. */
type CompletedLogin = {
	readonly authorizeUrl: URL;
	readonly exitCode: number;
	readonly printed: string[];
	readonly failures: string[];
	readonly exchanges: { path: string; form: URLSearchParams }[];
	/** What the browser was shown at the redirect URI. */
	readonly page: { status: number; body: string };
	/** The directory the token store was pointed at. */
	readonly store: string;
	readonly redirectUri: string;
	readonly whoopOrigin: string;
};

/**
 * Runs a whole login: starts a stand-in WHOOP, starts the command, plays the
 * browser's trip back to the loopback redirect, and waits for the command to
 * finish. Cases differ only in what {@link LoginScenario} exposes.
 */
async function completeLogin({
	env = {},
	reply = () => TOKENS_GRANTED,
	redirect = (authorizeUrl) => ({
		code: "an-authorization-code",
		state: authorizeUrl.searchParams.get("state") ?? "",
	}),
}: LoginScenario = {}): Promise<CompletedLogin> {
	const whoop = await startFakeWhoop(reply);
	const store = await temporaryStore();
	const redirectUri = await unusedRedirectUri();

	const login = startLogin({
		WHOOP_CLIENT_ID: "a-client-id",
		WHOOP_CLIENT_SECRET: "a-client-secret",
		WHOOP_REDIRECT_URI: redirectUri,
		WHOOP_API_BASE_URL: whoop.baseUrl,
		WHOOP_TOKEN_STORE: store,
		...env,
	});

	const authorizeUrl = await login.authorizeUrl;
	const page = await redirectBack(redirectUri, redirect(authorizeUrl));

	return {
		authorizeUrl,
		exitCode: await login.exitCode,
		printed: login.printed,
		failures: login.failures,
		exchanges: whoop.exchanges,
		page,
		store,
		redirectUri,
		whoopOrigin: whoop.baseUrl,
	};
}

describe("logging in over the loopback redirect", () => {
	it("stores the tokens, the granted scopes, and the app that earned them", async () => {
		const { exitCode, store } = await completeLogin();

		expect(exitCode).toBe(0);
		// The application rides along with the tokens so the serving process —
		// spawned by an MCP client with no WHOOP environment — can sign the
		// refreshes that keep this login alive.
		expect(await storedTokens(store)).toMatchObject({
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			scopes: ["read:profile", "read:sleep", "offline"],
			expiresAt: expect.any(Number),
			application: {
				clientId: "a-client-id",
				clientSecret: "a-client-secret",
			},
		});
	}, 30_000);

	it("prints an authorize URL for this app, redirect, state and scopes", async () => {
		const { authorizeUrl, redirectUri, whoopOrigin } = await completeLogin();

		expect(authorizeUrl.origin).toBe(whoopOrigin);
		expect(authorizeUrl.pathname).toBe("/oauth/oauth2/auth");
		expect(authorizeUrl.searchParams.get("client_id")).toBe("a-client-id");
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(authorizeUrl.searchParams.get("state")).toMatch(/\S{16,}/);
		expect(authorizeUrl.searchParams.get("scope")?.split(" ")).toEqual([
			"read:profile",
			"read:body_measurement",
			"read:cycles",
			"read:sleep",
			"read:recovery",
			"read:workout",
			"offline",
		]);
	}, 30_000);

	it("asks for exactly the scopes WHOOP_SCOPES narrows to, plus offline", async () => {
		const { authorizeUrl } = await completeLogin({
			env: { WHOOP_SCOPES: "read:sleep read:recovery" },
		});

		expect(authorizeUrl.searchParams.get("scope")?.split(" ")).toEqual([
			"read:sleep",
			"read:recovery",
			"offline",
		]);
	}, 30_000);

	it("exchanges the code with the app's credentials, then closes the loop", async () => {
		// A WHOOP that names no scope in its answer: the granted set is then the
		// set that was asked for.
		const silentAboutScope = {
			status: 200,
			body: {
				access_token: "an-access-token",
				refresh_token: "a-refresh-token",
				expires_in: 3600,
				token_type: "bearer",
			},
		};
		const { exitCode, exchanges, page, printed, redirectUri } =
			await completeLogin({
				env: { WHOOP_SCOPES: "read:sleep" },
				reply: () => silentAboutScope,
			});

		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]?.path).toBe("/oauth/oauth2/token");
		expect(Object.fromEntries(exchanges[0]?.form ?? [])).toMatchObject({
			grant_type: "authorization_code",
			code: "an-authorization-code",
			client_id: "a-client-id",
			client_secret: "a-client-secret",
			redirect_uri: redirectUri,
		});

		expect(page.status).toBe(200);
		expect(page.body).toMatch(/login complete/i);
		expect(page.body).toMatch(/close this tab/i);

		expect(printed.join("\n")).toContain("read:sleep offline");
		expect(exitCode).toBe(0);
	}, 30_000);

	// Windows has no POSIX mode bits — `stat` reports 0o666 there whatever the
	// file's real ACL says — so this is asserted where it means something.
	it.skipIf(process.platform === "win32")(
		"leaves the token file readable and writable by its owner only",
		async () => {
			const { exitCode, store } = await completeLogin();

			expect(exitCode).toBe(0);
			const { mode } = await stat(join(store, "tokens.json"));
			expect((mode & 0o777).toString(8)).toBe("600");
		},
		30_000,
	);

	it("refuses a redirect carrying a state it did not issue", async () => {
		const { exitCode, failures, exchanges, store } = await completeLogin({
			redirect: () => ({
				code: "an-authorization-code",
				state: "a-state-from-somewhere-else",
			}),
		});

		expect(exitCode).not.toBe(0);
		expect(failures.join("\n")).toMatch(/state mismatch/i);
		expect(exchanges).toEqual([]);
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
	}, 30_000);

	it("surfaces WHOOP's real over-ask refusal, which carries no state", async () => {
		// The answer the real WHOOP gives a scope the app may not request:
		// refused before any login or consent screen, the specific reason in
		// `error_hint`, and the `state` echoed back empty.
		const { exitCode, failures, exchanges, store } = await completeLogin({
			redirect: () => ({
				error: "invalid_scope",
				error_description:
					"The requested scope is invalid, unknown, or malformed",
				error_hint:
					'The OAuth 2.0 Client is not allowed to request scope "read:bogus_scope".',
				state: "",
			}),
		});

		expect(exitCode).not.toBe(0);
		expect(failures.join("\n")).toContain("invalid_scope");
		expect(failures.join("\n")).toContain(
			'not allowed to request scope "read:bogus_scope"',
		);
		expect(exchanges).toEqual([]);
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
	}, 30_000);

	it("surfaces the OAuth error when the exchange is rejected", async () => {
		const { exitCode, failures, store } = await completeLogin({
			reply: () => ({
				status: 400,
				body: {
					error: "invalid_grant",
					error_description: "authorization code expired",
				},
			}),
		});

		expect(exitCode).not.toBe(0);
		expect(failures.join("\n")).toContain("invalid_grant");
		expect(failures.join("\n")).toContain("authorization code expired");
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
	}, 30_000);
});

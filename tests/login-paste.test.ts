import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-paste-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
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

function startLogin(
	env: NodeJS.ProcessEnv,
	input: NodeJS.ReadableStream,
): RunningLogin {
	const printed: string[] = [];
	const failures: string[] = [];
	let announce: (url: URL) => void = () => {};
	const authorizeUrl = new Promise<URL>((resolve) => {
		announce = resolve;
	});

	const exitCode = runLogin({
		env,
		input,
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

/**
 * A redirect URI no loopback listener can ever be opened on, which is what
 * sends this login down the paste path.
 */
const HOSTED_REDIRECT_URI = "https://example.com/whoop/callback";

/**
 * A loopback redirect URI whose port is already taken — the login could listen
 * on it in principle, and cannot in fact.
 */
async function occupiedRedirectUri(): Promise<string> {
	return `${await listenOnLoopback(createServer())}/callback`;
}

/** What a case may vary on an otherwise working pasted login. */
type PasteScenario = {
	/** Environment on top of a working application's. */
	readonly env?: Record<string, string>;
	/** How the stand-in WHOOP answers the code exchange. */
	readonly reply?: () => TokenReply;
	/** Where WHOOP was told to send the browser. */
	readonly redirectUri?: string;
	/** What the user pastes, given where the browser was sent. */
	readonly paste?: (authorizeUrl: URL, redirectUri: string) => string;
};

/** A login run from the printed URL to the exit code, with what it left. */
type CompletedLogin = {
	readonly authorizeUrl: URL;
	readonly exitCode: number;
	readonly printed: string[];
	readonly failures: string[];
	readonly exchanges: { path: string; form: URLSearchParams }[];
	/** The directory the token store was pointed at. */
	readonly store: string;
	readonly redirectUri: string;
	readonly whoopOrigin: string;
};

/** The URL a browser that consented would be sitting on. */
function redirectedTo(
	redirectUri: string,
	query: Record<string, string>,
): string {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(query)) {
		url.searchParams.set(name, value);
	}

	return url.href;
}

/**
 * Runs a whole login: starts a stand-in WHOOP, starts the command, then plays
 * the user typing the redirected URL back into the terminal. Cases differ only
 * in what {@link PasteScenario} exposes.
 */
async function completeLogin({
	env = {},
	reply = () => TOKENS_GRANTED,
	redirectUri = HOSTED_REDIRECT_URI,
	paste = (authorizeUrl, uri) =>
		redirectedTo(uri, {
			code: "an-authorization-code",
			state: authorizeUrl.searchParams.get("state") ?? "",
		}),
}: PasteScenario = {}): Promise<CompletedLogin> {
	const whoop = await startFakeWhoop(reply);
	const store = await temporaryStore();
	const typed = new PassThrough();
	opened.push(async () => {
		typed.destroy();
	});

	const login = startLogin(
		{
			WHOOP_CLIENT_ID: "a-client-id",
			WHOOP_CLIENT_SECRET: "a-client-secret",
			WHOOP_REDIRECT_URI: redirectUri,
			WHOOP_API_BASE_URL: whoop.baseUrl,
			WHOOP_TOKEN_STORE: store,
			...env,
		},
		typed,
	);

	const authorizeUrl = await login.authorizeUrl;
	typed.write(`${paste(authorizeUrl, redirectUri)}\n`);

	return {
		authorizeUrl,
		exitCode: await login.exitCode,
		printed: login.printed,
		failures: login.failures,
		exchanges: whoop.exchanges,
		store,
		redirectUri,
		whoopOrigin: whoop.baseUrl,
	};
}

describe("logging in by pasting the redirected URL", () => {
	it("stores the tokens and the granted scopes the pasted code bought", async () => {
		const { exitCode, exchanges, printed, redirectUri, store } =
			await completeLogin();

		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]?.path).toBe("/oauth/oauth2/token");
		expect(Object.fromEntries(exchanges[0]?.form ?? [])).toMatchObject({
			grant_type: "authorization_code",
			code: "an-authorization-code",
			client_id: "a-client-id",
			client_secret: "a-client-secret",
			redirect_uri: redirectUri,
		});

		expect(await storedTokens(store)).toMatchObject({
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			scopes: ["read:profile", "read:sleep", "offline"],
			expiresAt: expect.any(Number),
		});
		expect(printed.join("\n")).toContain(
			"Granted scopes: read:profile read:sleep offline",
		);
		expect(exitCode).toBe(0);
	}, 30_000);

	it("asks for the redirected URL instead of waiting to be sent one", async () => {
		const { authorizeUrl, printed } = await completeLogin();
		const transcript = printed.join("\n");

		expect(transcript).toMatch(/paste the full URL/i);
		expect(transcript).not.toMatch(/waiting for WHOOP/i);
		// The ask only makes sense once the user has somewhere to be sent from.
		const said = transcript.toLowerCase();
		expect(said.indexOf("paste")).toBeGreaterThan(
			said.indexOf(authorizeUrl.href.toLowerCase()),
		);
	}, 30_000);

	it.each([
		{
			what: "no code",
			paste: (authorizeUrl: URL, uri: string) =>
				redirectedTo(uri, {
					state: authorizeUrl.searchParams.get("state") ?? "",
				}),
			says: /no code/i,
		},
		{
			what: "a state this login never issued",
			paste: (_authorizeUrl: URL, uri: string) =>
				redirectedTo(uri, {
					code: "an-authorization-code",
					state: "a-state-from-somewhere-else",
				}),
			says: /state mismatch/i,
		},
	])(
		"refuses a pasted URL carrying $what, storing nothing",
		async ({ paste, says }) => {
			const { exitCode, exchanges, failures, store } = await completeLogin({
				paste,
			});

			expect(exitCode).not.toBe(0);
			expect(failures.join("\n")).toMatch(says);
			expect(exchanges).toEqual([]);
			expect(existsSync(join(store, "tokens.json"))).toBe(false);
		},
		30_000,
	);

	it("falls back to the prompt when the loopback port is taken", async () => {
		const { exitCode, printed, store } = await completeLogin({
			redirectUri: await occupiedRedirectUri(),
		});

		expect(printed.join("\n")).toMatch(/paste the full URL/i);
		expect(await storedTokens(store)).toMatchObject({
			accessToken: "an-access-token",
		});
		expect(exitCode).toBe(0);
	}, 30_000);
});

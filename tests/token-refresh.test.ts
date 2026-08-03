import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { readStoredTokens, writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

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
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-refresh-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** The profile the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** One request the stand-in WHOOP was asked to serve, body included. */
type WhoopRequest = {
	method: string;
	path: string;
	authorization: string | undefined;
	/** The form body, so a case can assert on the grant that was used. */
	body: URLSearchParams;
};

/** What the stand-in WHOOP's token endpoint answers a refresh grant with. */
type RefreshAnswer =
	| {
			rotated: {
				access_token: string;
				refresh_token: string;
				expires_in: number;
			};
	  }
	| { rejected: { error: string; error_description?: string } };

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * A stand-in WHOOP for the refresh loop: its profile endpoint only honours the
 * one access token it currently considers valid — anything else earns a 401,
 * exactly how a rotated-away or revoked token dies upstream — and its token
 * endpoint answers refresh grants with a configured rotation or rejection.
 */
async function startFakeWhoop(options: {
	/** The only access token the profile endpoint accepts. */
	accepts: string;
	/** How the token endpoint answers a refresh grant. */
	refresh: RefreshAnswer;
}): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on("end", () => {
			const path = new URL(request.url ?? "/", "http://whoop.invalid").pathname;
			const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
			requests.push({
				method: request.method ?? "",
				path,
				authorization: request.headers.authorization,
				body,
			});

			const answer = (status: number, payload: unknown): void => {
				response.writeHead(status, {
					"content-type": "application/json",
					connection: "close",
				});
				response.end(JSON.stringify(payload));
			};

			if (path === "/oauth/oauth2/token") {
				if ("rejected" in options.refresh) {
					answer(400, options.refresh.rejected);
				} else {
					answer(200, {
						...options.refresh.rotated,
						scope: "read:profile offline",
						token_type: "bearer",
					});
				}

				return;
			}

			if (path === "/developer/v2/user/profile/basic") {
				if (request.headers.authorization === `Bearer ${options.accepts}`) {
					answer(200, PROFILE);
				} else {
					answer(401, { error: "invalid_token" });
				}

				return;
			}

			answer(404, {});
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/** The refresh-grant requests the stand-in WHOOP saw, in order. */
function refreshRequests(whoop: FakeWhoop): WhoopRequest[] {
	return whoop.requests.filter(
		(request) =>
			request.path === "/oauth/oauth2/token" &&
			request.body.get("grant_type") === "refresh_token",
	);
}

/** The profile reads the stand-in WHOOP saw, in order. */
function profileRequests(whoop: FakeWhoop): WhoopRequest[] {
	return whoop.requests.filter(
		(request) => request.path === "/developer/v2/user/profile/basic",
	);
}

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP. An MCP host spawns the server with no WHOOP
 * variables of its own, so none are passed unless a case says otherwise:
 * refreshes are expected to sign themselves with what the login stored.
 */
async function withClient<T>(
	env: {
		store: string;
		whoopBaseUrl: string;
		credentials?: { clientId: string; clientSecret: string };
	},
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({
		name: "token-refresh-test",
		version: "0.0.0",
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
			...(env.credentials && {
				WHOOP_CLIENT_ID: env.credentials.clientId,
				WHOOP_CLIENT_SECRET: env.credentials.clientSecret,
			}),
		},
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

/** The application a login would have recorded beside the tokens it earned. */
const STORED_APPLICATION = {
	clientId: "stored-client-id",
	clientSecret: "stored-client-secret",
};

/**
 * Seeds the store with a login whose access token expired a minute ago —
 * complete with the application a login records, unless the case is about a
 * store that names none.
 */
async function seedExpiredLogin(
	store: string,
	options: { application: boolean } = { application: true },
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "stale-access",
			refreshToken: "seed-refresh",
			expiresAt: Date.now() - 60_000,
			scopes: ["read:profile", "offline"],
			...(options.application && { application: STORED_APPLICATION }),
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/** The rotation the stand-in WHOOP hands out when a refresh succeeds. */
const ROTATED = {
	access_token: "rotated-access",
	refresh_token: "rotated-refresh",
	expires_in: 3600,
};

describe("token refresh around authorized calls, over real stdio", () => {
	it("refreshes an expired login before the data request, and the call succeeds", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rotated: ROTATED },
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);

		// The refresh grant carried the stored refresh token, signed with the
		// application the login stored — the serving process was spawned with no
		// WHOOP environment at all — and it landed before any data request did.
		const [refresh] = refreshRequests(whoop);
		expect(refresh?.body.get("refresh_token")).toBe("seed-refresh");
		expect(refresh?.body.get("client_id")).toBe("stored-client-id");
		expect(refresh?.body.get("client_secret")).toBe("stored-client-secret");
		expect(whoop.requests.indexOf(refresh as WhoopRequest)).toBeLessThan(
			whoop.requests.indexOf(profileRequests(whoop)[0] as WhoopRequest),
		);
	}, 30_000);

	it("persists the rotated pair, dropping the spent refresh token", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rotated: ROTATED },
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);
		expect(result.isError).not.toBe(true);

		// The store — the only thing a later process shares with this one — now
		// holds the rotated pair; the single-use refresh token that was spent is
		// gone with the access token it renewed. The application rides along, so
		// the next refresh is just as self-sufficient.
		const stored = await readStoredTokens({
			env: { WHOOP_TOKEN_STORE: store },
		});
		expect(stored?.accessToken).toBe("rotated-access");
		expect(stored?.refreshToken).toBe("rotated-refresh");
		expect(stored?.application).toEqual(STORED_APPLICATION);
	}, 30_000);

	it("refreshes and retries once when WHOOP rejects an unexpired token", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rotated: ROTATED },
		});
		const store = await temporaryStore();
		// The store believes this access token has an hour left, but WHOOP
		// disagrees — say it was revoked upstream — and answers 401.
		await writeStoredTokens(
			{
				accessToken: "revoked-access",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
				scopes: ["read:profile", "offline"],
				application: STORED_APPLICATION,
			},
			{ env: { WHOOP_TOKEN_STORE: store } },
		);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);

		// The stored token was tried first — it was not known to be expired —
		// then the 401 bought exactly one refresh-and-retry.
		const profiles = profileRequests(whoop);
		expect(profiles.map((request) => request.authorization)).toEqual([
			"Bearer revoked-access",
			"Bearer rotated-access",
		]);
		expect(refreshRequests(whoop)).toHaveLength(1);
	}, 30_000);

	it("names the login command when the refresh token itself is rejected", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rejected: { error: "invalid_grant" } },
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const outcome = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client
					.callTool({ name: "get_profile", arguments: {} })
					.then((result) => ({
						failed: result.isError === true,
						text: JSON.stringify(result.content),
					}))
					.catch((error: unknown) => ({ failed: true, text: String(error) })),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("no longer valid");
		expect(outcome.text).toContain("npx mcp-whoop login");
	}, 30_000);

	it("reads WHOOP's real revoked-token answer as the login being dead", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			// The answer the real WHOOP gives a revoked refresh token:
			// `invalid_request` with the RFC's generic text, not the
			// `invalid_grant` OAuth promises.
			refresh: {
				rejected: {
					error: "invalid_request",
					error_description:
						"The request is missing a required parameter, includes an invalid parameter value, includes a parameter more than once, or is otherwise malformed",
				},
			},
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const outcome = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client
					.callTool({ name: "get_profile", arguments: {} })
					.then((result) => ({
						failed: result.isError === true,
						text: JSON.stringify(result.content),
					}))
					.catch((error: unknown) => ({ failed: true, text: String(error) })),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("no longer valid");
		expect(outcome.text).toContain("npx mcp-whoop login");
	}, 30_000);

	it("reads a scope disabled since the login as the login being dead", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			// The answer the real WHOOP gives a refresh whose login was granted a
			// scope the dashboard has since disabled: that chain can never
			// refresh again, so the only remedy is a new login.
			refresh: {
				rejected: {
					error: "invalid_scope",
					error_description:
						"The requested scope is invalid, unknown, or malformed",
				},
			},
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const outcome = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client
					.callTool({ name: "get_profile", arguments: {} })
					.then((result) => ({
						failed: result.isError === true,
						text: JSON.stringify(result.content),
					}))
					.catch((error: unknown) => ({ failed: true, text: String(error) })),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("no longer valid");
		expect(outcome.text).toContain("npx mcp-whoop login");
	}, 30_000);

	it("signs the refresh with the environment's credentials over the stored pair", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rotated: ROTATED },
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const result = await withClient(
			{
				store,
				whoopBaseUrl: whoop.baseUrl,
				credentials: {
					clientId: "env-client-id",
					clientSecret: "env-client-secret",
				},
			},
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);
		expect(result.isError).not.toBe(true);

		// Explicit configuration outranks recorded state — this is how a secret
		// rotated in WHOOP's dashboard reaches a store that predates it — and
		// the pair that proved it can spend the login replaces the stored one.
		const [refresh] = refreshRequests(whoop);
		expect(refresh?.body.get("client_id")).toBe("env-client-id");
		expect(refresh?.body.get("client_secret")).toBe("env-client-secret");
		const stored = await readStoredTokens({
			env: { WHOOP_TOKEN_STORE: store },
		});
		expect(stored?.application).toEqual({
			clientId: "env-client-id",
			clientSecret: "env-client-secret",
		});
	}, 30_000);

	it("names both remedies when neither the store nor the environment can sign", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rotated: ROTATED },
		});
		const store = await temporaryStore();
		// A store that names no application, served by a process with no WHOOP
		// environment: nothing can sign the refresh.
		await seedExpiredLogin(store, { application: false });

		const outcome = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client
					.callTool({ name: "get_profile", arguments: {} })
					.then((result) => ({
						failed: result.isError === true,
						text: JSON.stringify(result.content),
					}))
					.catch((error: unknown) => ({ failed: true, text: String(error) })),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("npx mcp-whoop login");
		expect(outcome.text).toContain("WHOOP_CLIENT_ID");
		// No doomed grant went out: WHOOP never saw a refresh it would reject.
		expect(refreshRequests(whoop)).toHaveLength(0);
	}, 30_000);

	it("does not refresh again once the rotated pair is stored", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			refresh: { rotated: ROTATED },
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		// The first call refreshes; the second runs in a fresh server process,
		// so only the persisted rotation can spare it another round trip.
		const first = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);
		const second = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) => client.callTool({ name: "get_profile", arguments: {} }),
		);

		expect(first.isError).not.toBe(true);
		expect(second.isError).not.toBe(true);
		expect(refreshRequests(whoop)).toHaveLength(1);
	}, 30_000);
});

import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withValidAccessToken } from "@/whoop/auth/tokens/authorized";
import { storeLockPath } from "@/whoop/auth/tokens/lock";
import {
	type StoredTokens,
	writeStoredTokens,
} from "@/whoop/auth/tokens/store";

import {
	listenOnLoopback,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** A promise that settles after the given pause — the test's only clock. */
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

/** The pair the stand-in WHOOP rotates a refresh token into. */
type Rotation = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * A stand-in WHOOP whose refresh tokens are single-use, the property these
 * cases turn on. Each token in `grants` is honoured exactly once — spent or
 * unknown tokens earn `invalid_request`, the answer the real WHOOP gives a
 * dead refresh token (not the `invalid_grant` OAuth promises), which is how it
 * kills the loser of a refresh race. The token endpoint can be slowed down, so
 * two processes are reliably in flight at once, and can run a hook before it
 * answers, so a case can interleave another process's write mid-refresh.
 */
async function startFakeWhoop(options: {
	/** The only access token the profile endpoint accepts. */
	accepts: string;
	/** Refresh tokens the token endpoint honours — each exactly once. */
	grants?: Map<string, Rotation>;
	/** How long the token endpoint sits on every answer. */
	refreshDelayMs?: number;
	/** Runs after a refresh grant arrives and before it is answered. */
	onRefresh?: (refreshToken: string) => Promise<void>;
}): Promise<FakeWhoop> {
	const grants = new Map(options.grants ?? []);
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
				// Consumed on arrival, not on answer: a second use of the same
				// token is already spent even while the first is still in flight.
				const presented = body.get("refresh_token") ?? "";
				const rotation = grants.get(presented);
				grants.delete(presented);

				const respond = async (): Promise<void> => {
					await options.onRefresh?.(presented);
					if (options.refreshDelayMs) {
						await pause(options.refreshDelayMs);
					}
					if (rotation) {
						answer(200, {
							...rotation,
							scope: "read:profile offline",
							token_type: "bearer",
						});
					} else {
						answer(400, { error: "invalid_request" });
					}
				};
				respond().catch(() => answer(500, {}));

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

/** Seeds the store with a login whose access token expired a minute ago. */
async function seedExpiredLogin(store: string): Promise<StoredTokens> {
	const tokens = {
		accessToken: "stale-access",
		refreshToken: "seed-refresh",
		expiresAt: Date.now() - 60_000,
		scopes: ["read:profile", "offline"],
	};
	await writeStoredTokens(tokens, { env: { WHOOP_TOKEN_STORE: store } });

	return tokens;
}

/**
 * The environment the store-level cases drive the refresh seam with — the
 * same variables the stdio cases hand the spawned server process.
 */
function storeEnv(store: string, whoop: FakeWhoop): NodeJS.ProcessEnv {
	return {
		WHOOP_TOKEN_STORE: store,
		WHOOP_API_BASE_URL: whoop.baseUrl,
		WHOOP_CLIENT_ID: "a-client-id",
		WHOOP_CLIENT_SECRET: "a-client-secret",
	};
}

/** The rotation the stand-in WHOOP hands out for the seeded refresh token. */
const ROTATED = {
	access_token: "rotated-access",
	refresh_token: "rotated-refresh",
	expires_in: 3600,
};

describe("single-flight refresh across processes", () => {
	it("sends exactly one refresh when two processes race an expired token, and both calls succeed", async () => {
		const whoop = await startFakeWhoop({
			accepts: "rotated-access",
			grants: new Map([["seed-refresh", ROTATED]]),
			// Slow enough that the second process reaches refresh while the
			// first is still waiting on WHOOP — the race being tested.
			refreshDelayMs: 750,
		});
		const store = await temporaryStore();
		await seedExpiredLogin(store);

		const clientOptions = {
			store,
			whoopBaseUrl: whoop.baseUrl,
			credentials: {
				clientId: "a-client-id",
				clientSecret: "a-client-secret",
			},
		};
		const [a, b] = await withBuiltStdioClient(clientOptions, (first) =>
			withBuiltStdioClient(clientOptions, (second) =>
				Promise.all([
					first.callTool({ name: "get_profile", arguments: {} }),
					second.callTool({ name: "get_profile", arguments: {} }),
				]),
			),
		);

		// Both processes served their call — the loser of the race adopted the
		// winner's rotation instead of dying on a spent refresh token.
		expect(a.isError).not.toBe(true);
		expect(b.isError).not.toBe(true);
		expect(a.structuredContent).toEqual(PROFILE);
		expect(b.structuredContent).toEqual(PROFILE);

		// And the single-use refresh token was spent exactly once.
		expect(refreshRequests(whoop)).toHaveLength(1);
	});

	it("waits on a held lock and adopts the rotation without contacting the token endpoint", async () => {
		// No grants at all: any refresh reaching this WHOOP would be rejected,
		// so the case proves the waiter never asked.
		const whoop = await startFakeWhoop({ accepts: "rotated-access" });
		const store = await temporaryStore();
		const seeded = await seedExpiredLogin(store);
		const env = storeEnv(store, whoop);

		// Another process holds the refresh lock: on disk, that is exactly a
		// lockfile that exists.
		const lock = storeLockPath({ env });
		await writeFile(lock, "");

		let settled = false;
		const call = withValidAccessToken(
			seeded,
			(accessToken) => Promise.resolve(accessToken),
			{ env },
		).finally(() => {
			settled = true;
		});

		// While the lock is held, the would-be refresher waits: no answer for
		// its caller, and nothing sent to the token endpoint.
		await pause(300);
		expect(settled).toBe(false);
		expect(refreshRequests(whoop)).toHaveLength(0);

		// The holder finishes its refresh — rotation written, lock released —
		// and the waiter comes back with the adopted access token.
		await writeStoredTokens(
			{
				accessToken: "rotated-access",
				refreshToken: "rotated-refresh",
				expiresAt: Date.now() + 3_600_000,
				scopes: ["read:profile", "offline"],
			},
			{ env },
		);
		await rm(lock);

		expect(await call).toBe("rotated-access");
		expect(refreshRequests(whoop)).toHaveLength(0);
	});

	it("adopts the newer stored tokens when its own refresh fails as already spent", async () => {
		const store = await temporaryStore();
		// No grants: the seeded refresh token is already spent upstream. While
		// this process's doomed refresh is in flight, the process that spent it
		// lands its rotation in the store — the interleaving a lock takeover
		// produces.
		const whoop = await startFakeWhoop({
			accepts: "newer-access",
			onRefresh: async () => {
				await writeStoredTokens(
					{
						accessToken: "newer-access",
						refreshToken: "newer-refresh",
						expiresAt: Date.now() + 3_600_000,
						scopes: ["read:profile", "offline"],
					},
					{ env: { WHOOP_TOKEN_STORE: store } },
				);
			},
		});
		const seeded = await seedExpiredLogin(store);

		const used: string[] = [];
		const result = await withValidAccessToken(
			seeded,
			(accessToken) => {
				used.push(accessToken);

				return Promise.resolve("served");
			},
			{ env: storeEnv(store, whoop) },
		);

		// The failed refresh was re-read into the newer rotation, and the call
		// completed with it — no dead-login error for a login that is alive.
		expect(result).toBe("served");
		expect(used).toEqual(["newer-access"]);
		expect(refreshRequests(whoop)).toHaveLength(1);
	});

	it("declares the login dead after one look when the store holds nothing newer", async () => {
		// No grants and no concurrent rotation: the refresh token is spent and
		// the store still names it, so the login really is dead.
		const whoop = await startFakeWhoop({ accepts: "rotated-access" });
		const store = await temporaryStore();
		const seeded = await seedExpiredLogin(store);

		const outcome = await withValidAccessToken(
			seeded,
			(accessToken) => Promise.resolve(accessToken),
			{ env: storeEnv(store, whoop) },
		).then(
			() => ({ failed: false, text: "" }),
			(error: unknown) => ({ failed: true, text: String(error) }),
		);

		// Dead means the message the user can act on — and no second refresh,
		// because WHOOP already gave its definitive answer.
		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("no longer valid");
		expect(outcome.text).toContain("npx mcp-whoop login");
		expect(refreshRequests(whoop)).toHaveLength(1);
	});

	it("keeps every read complete, valid JSON while many writes land concurrently", async () => {
		const store = await temporaryStore();
		const env = { WHOOP_TOKEN_STORE: store };
		const tokensNumbered = (n: number): StoredTokens => ({
			accessToken: `access-${n}`,
			refreshToken: `refresh-${n}`,
			expiresAt: 1_700_000_000_000 + n,
			scopes: ["read:profile", "offline"],
		});
		await writeStoredTokens(tokensNumbered(0), { env });

		// Read the raw file as fast as the writes allow, and demand that every
		// body that comes back is whole: parseable JSON naming a full token
		// set, never a torn half-write and never a store that vanished
		// mid-replace. The reader only records problems — asserting happens
		// after it stops, so a failure cannot orphan it.
		const path = join(store, "tokens.json");
		const problems: string[] = [];
		let reads = 0;
		let writing = true;
		const reader = (async (): Promise<void> => {
			while (writing) {
				let body: string;
				try {
					body = await readFile(path, "utf8");
				} catch (error) {
					// A file that cannot be opened proves nothing about torn
					// content — except ENOENT, which would mean the store
					// vanished mid-replace, exactly what the rename forbids.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						problems.push("the store vanished mid-replace");
					}
					continue;
				}
				reads += 1;
				try {
					const parsed = JSON.parse(body) as Partial<StoredTokens>;
					if (typeof parsed.accessToken !== "string") {
						problems.push(body);
					}
				} catch {
					problems.push(body);
				}
			}
		})();

		try {
			await Promise.all(
				Array.from({ length: 25 }, (_, n) =>
					writeStoredTokens(tokensNumbered(n + 1), { env }),
				),
			);
		} finally {
			writing = false;
			await reader;
		}

		expect(reads).toBeGreaterThan(0);
		expect(problems).toEqual([]);
	});
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { readStoredTokens } from "@/whoop/auth/tokens/store";

import {
	builtEntry,
	listenOnLoopback,
	repoRoot,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

const run = promisify(execFile);

/** The profile the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** The application an older store records: a client pair, no redirect URI. */
const STORED_APPLICATION = {
	clientId: "stored-client-id",
	clientSecret: "stored-client-secret",
};

/** The access token the stand-in WHOOP rotates the expired login to. */
const ROTATED_ACCESS_TOKEN = "rotated-access-token";

type WhoopRequest = {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | undefined;
	/** The parsed form body, so a case can assert on the grant that was used. */
	readonly form: URLSearchParams;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * A stand-in WHOOP for a whole life cycle: it rotates a refresh grant, serves
 * the profile only to the rotated access token — anything else gets a 401 — and
 * honours the revocation a logout ends with.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const path = new URL(request.url ?? "/", "http://whoop.invalid").pathname;
			requests.push({
				method: request.method ?? "",
				path,
				authorization: request.headers.authorization,
				form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
			});

			const answer = (status: number, payload?: unknown): void => {
				response.writeHead(status, {
					"content-type": "application/json",
					connection: "close",
				});
				response.end(payload === undefined ? "" : JSON.stringify(payload));
			};

			if (path === "/oauth/oauth2/token") {
				answer(200, {
					access_token: ROTATED_ACCESS_TOKEN,
					refresh_token: "rotated-refresh-token",
					expires_in: 3600,
					scope: "read:profile offline",
					token_type: "bearer",
				});

				return;
			}
			if (path === "/developer/v2/user/profile/basic") {
				answer(
					request.headers.authorization === `Bearer ${ROTATED_ACCESS_TOKEN}`
						? 200
						: 401,
					request.headers.authorization === `Bearer ${ROTATED_ACCESS_TOKEN}`
						? PROFILE
						: { error: "invalid_token" },
				);

				return;
			}
			if (path === "/developer/v2/user/access") {
				answer(204);

				return;
			}
			answer(404, {});
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/**
 * Writes the token file as this package wrote one before the redirect URI
 * joined the application record — as raw bytes rather than through the current
 * writer, so the fixture cannot drift with it. Its access token is already
 * expired, forcing a refresh.
 */
async function seedStoreWithoutRedirectUri(store: string): Promise<void> {
	await writeFile(
		join(store, "tokens.json"),
		`${JSON.stringify(
			{
				accessToken: "stored-access-token",
				refreshToken: "stored-refresh-token",
				expiresAt: Date.now() - 60_000,
				scopes: ["read:profile", "offline"],
				application: STORED_APPLICATION,
			},
			null,
			"\t",
		)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

function requestsTo(whoop: FakeWhoop, path: string): WhoopRequest[] {
	return whoop.requests.filter((request) => request.path === path);
}

/**
 * Runs the built CLI's `logout` as a real child process against the given token
 * store and stand-in WHOOP, and returns its exit code.
 */
async function runLogout(env: {
	store: string;
	whoopBaseUrl: string;
}): Promise<number> {
	try {
		await run(process.execPath, [builtEntry, "logout"], {
			cwd: repoRoot,
			env: {
				...process.env,
				WHOOP_TOKEN_STORE: env.store,
				WHOOP_API_BASE_URL: env.whoopBaseUrl,
			},
		});

		return 0;
	} catch (error) {
		return (error as { code?: number }).code ?? 1;
	}
}

describe("a token store written before the redirect URI was recorded", () => {
	it("loads, and refreshes, narrows the surface and logs out unchanged", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStoreWithoutRedirectUri(store);

		const { names, result } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				names: (await client.listTools()).tools.map((tool) => tool.name),
				result: await client.callTool({ name: "get_profile", arguments: {} }),
			}),
		);

		// The store loaded: the scopes it records still shape the tool surface.
		expect(names).toEqual(["get_profile"]);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(PROFILE);

		// The refresh signs with the stored pair, all such a store carries.
		const [refresh] = requestsTo(whoop, "/oauth/oauth2/token");
		expect(refresh?.form.get("refresh_token")).toBe("stored-refresh-token");
		expect(refresh?.form.get("client_id")).toBe(STORED_APPLICATION.clientId);
		expect(refresh?.form.get("client_secret")).toBe(
			STORED_APPLICATION.clientSecret,
		);
		// The rotation writes back no redirect URI either: none is invented for a
		// login that never recorded one.
		const rotated = await readStoredTokens({
			env: { WHOOP_TOKEN_STORE: store },
		});
		expect(rotated?.application).toEqual(STORED_APPLICATION);

		expect(await runLogout({ store, whoopBaseUrl: whoop.baseUrl })).toBe(0);
		expect(
			requestsTo(whoop, "/developer/v2/user/access").map((request) => ({
				method: request.method,
				authorization: request.authorization,
			})),
		).toEqual([
			{ method: "DELETE", authorization: `Bearer ${ROTATED_ACCESS_TOKEN}` },
		]);
		expect(existsSync(join(store, "tokens.json"))).toBe(false);
	});
});

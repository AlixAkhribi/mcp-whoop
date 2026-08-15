import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { writeStoredTokens } from "@/whoop/auth/tokens/store";

import {
	callToolOutcome,
	listenOnLoopback,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** One canned answer a stand-in WHOOP endpoint gives, headers included. */
type Answer = {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
};

/**
 * A stand-in WHOOP whose answers a case scripts per endpoint: rate limits with
 * a Retry-After, outages, and client errors carrying WHOOP's own message.
 */
async function startFakeWhoop(answers: {
	token?: Answer;
	profile?: Answer;
}): Promise<{ baseUrl: string }> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const path = new URL(request.url ?? "/", "http://whoop.invalid").pathname;
			const answer =
				path === "/oauth/oauth2/token"
					? answers.token
					: path === "/developer/v2/user/profile/basic"
						? answers.profile
						: undefined;

			response.writeHead(answer?.status ?? 404, {
				"content-type": "application/json",
				connection: "close",
				...answer?.headers,
			});
			response.end(JSON.stringify(answer?.body ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server) };
}

/**
 * A stand-in WHOOP that accepts the request and then never answers it: no
 * status line, no body, the socket simply left open — the black hole a request
 * has to give up on by itself.
 */
async function startSilentWhoop(): Promise<{ baseUrl: string }> {
	const server = createServer((request) => {
		request.resume();
	});

	return { baseUrl: await listenOnLoopback(server) };
}

/** A base URL whose port was just released, so nothing answers on it. */
async function closedPortBaseUrl(): Promise<string> {
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

	return `http://127.0.0.1:${port}`;
}

/** Seeds the store with a login, either still trusted or already expired. */
async function seedLogin(
	store: string,
	options: { expired: boolean },
): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + (options.expired ? -60_000 : 3_600_000),
			scopes: ["read:profile", "offline"],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * Calls one tool on the built server over real stdio — a separate process,
 * exactly what an MCP host spawns — and reduces the two shapes a failure can
 * take to one record, so a case can assert on the failure text alone.
 *
 * `httpTimeoutMs` turns the bound on WHOOP requests down to something a case
 * can wait out; left off, the server keeps its own.
 */
async function callTool(
	env: { store: string; whoopBaseUrl: string; httpTimeoutMs?: number },
	name: string,
): Promise<{ failed: boolean; text: string }> {
	return withBuiltStdioClient(
		{
			...env,
			credentials: {
				clientId: "a-client-id",
				clientSecret: "a-client-secret",
			},
		},
		async (client) => {
			const { failed, text } = await callToolOutcome(client, name);

			return { failed, text };
		},
	);
}

describe("the error taxonomy at the tool boundary, over real stdio", () => {
	it("marks a 429 with Retry-After as rate-limited and retryable, naming the wait", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 429,
				body: { error: "too_many_requests" },
				headers: { "retry-after": "30" },
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/rate-limited/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		expect(outcome.text).toContain("30 seconds");
	});

	it("names the wait from X-RateLimit-Reset when WHOOP sends no Retry-After", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 429,
				body: { error: "too_many_requests" },
				// The header WHOOP's own rate-limiting documentation names, in the
				// same seconds Retry-After would be counted in — and the only one
				// WHOOP is documented to send.
				headers: { "x-ratelimit-reset": "30" },
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/rate-limited/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		expect(outcome.text).toContain("30 seconds");
	});

	it("takes Retry-After over X-RateLimit-Reset when WHOOP sends both", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 429,
				body: { error: "too_many_requests" },
				headers: { "retry-after": "30", "x-ratelimit-reset": "90" },
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		// The HTTP standard header is the one to obey when it is there at all.
		expect(outcome.text).toContain("30 seconds");
		expect(outcome.text).not.toContain("90");
	});

	it("marks a 503 as retryable, naming a temporary WHOOP outage", async () => {
		const whoop = await startFakeWhoop({
			profile: { status: 503, body: { error: "service_unavailable" } },
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/temporar/i);
		expect(outcome.text).toMatch(/outage/i);
		expect(outcome.text).toMatch(/safe to retry/i);
	});

	it("marks a WHOOP that cannot be reached as a retryable network failure", async () => {
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: await closedPortBaseUrl() },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/network/i);
		expect(outcome.text).toMatch(/safe to retry/i);
	});

	it("distinguishes a bounded timeout from caller cancellation and keeps it retryable", async () => {
		const whoop = await startSilentWhoop();
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const startedAt = Date.now();
		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl, httpTimeoutMs: 1_000 },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/timed out/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		// The point of the bound: unbounded, this call would sit here for the
		// minutes Node's own defaults allow.
		expect(Date.now() - startedAt).toBeLessThan(15_000);
	});

	it("marks a 400 as fatal, carrying WHOOP's own message", async () => {
		const whoop = await startFakeWhoop({
			profile: {
				status: 400,
				body: {
					error: "invalid_request",
					message: "Query param start must be before end",
				},
			},
		});
		const store = await temporaryStore();
		await seedLogin(store, { expired: false });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("Query param start must be before end");
		expect(outcome.text).toMatch(/will not help/i);
		expect(outcome.text).not.toMatch(/safe to retry/i);
	});

	it("marks a 429 during token refresh as rate-limited, not as a dead login", async () => {
		const whoop = await startFakeWhoop({
			token: {
				status: 429,
				body: { error: "too_many_requests" },
				headers: { "retry-after": "30" },
			},
		});
		const store = await temporaryStore();
		// An expired login forces the refresh before any data request goes out,
		// so the rate limit lands on the refresh path itself.
		await seedLogin(store, { expired: true });

		const outcome = await callTool(
			{ store, whoopBaseUrl: whoop.baseUrl },
			"get_profile",
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toMatch(/rate-limited/i);
		expect(outcome.text).toMatch(/safe to retry/i);
		expect(outcome.text).not.toContain("no longer valid");
		expect(outcome.text).not.toContain("npx mcp-whoop login");
	});
});

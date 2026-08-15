import { createServer, type Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { writeStoredTokens } from "@/whoop/auth/tokens/store";

import {
	listenOnLoopback,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/**
 * A stand-in WHOOP serving only the v2 basic-profile endpoint — enough for one
 * tool call to succeed, which is all these cases narrate.
 */
async function startFakeWhoop(): Promise<string> {
	const server: Server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(
				JSON.stringify({
					user_id: 10_129,
					email: "ada@example.com",
					first_name: "Ada",
					last_name: "Lovelace",
				}),
			);
		});
	});
	return listenOnLoopback(server);
}

/** The tokens a completed login would have left behind, not yet expired. */
const SEEDED_TOKENS = {
	accessToken: "an-access-token",
	refreshToken: "a-refresh-token",
	expiresAt: Date.now() + 3_600_000,
	scopes: ["read:profile", "offline"],
};

/**
 * Spawns the built server over real stdio with its stderr piped instead of
 * inherited, runs one `get_profile` call, and reports everything the server
 * wrote to stderr along the way. The call succeeding is itself the stdout
 * assertion: a diagnostic straying onto the wire would break the framing the
 * client just parsed.
 */
async function stderrOfOneProfileCall(env: {
	store: string;
	whoopBaseUrl: string;
	logLevel?: string;
}): Promise<() => string> {
	return withBuiltStdioClient(
		{ ...env, stderr: "pipe" },
		async (client, _transport, stderr) => {
			const result = await client.callTool({
				name: "get_profile",
				arguments: {},
			});
			expect(result.isError).not.toBe(true);

			return stderr;
		},
	);
}

describe("serving diagnostics over real stdio", () => {
	it("narrates a tool call on stderr at debug, redacting the token", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await writeStoredTokens(SEEDED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const stderr = await stderrOfOneProfileCall({
			store,
			whoopBaseUrl,
			logLevel: "debug",
		});

		await vi.waitFor(() => {
			expect(stderr()).toContain("get_profile answered in");
		});

		// The announcement names what is serving; the narration names the call
		// and the upstream read beneath it, status and all.
		expect(stderr()).toContain("serving MCP over stdio");
		expect(stderr()).toContain("[debug] get_profile called");
		expect(stderr()).toContain(
			"GET /developer/v2/user/profile/basic answered 200",
		);

		// The bearer token crossed the process during that call; no line may
		// carry it out.
		expect(stderr()).not.toContain("an-access-token");
	});

	it("keeps per-request narration quiet at the default level", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await writeStoredTokens(SEEDED_TOKENS, {
			env: { WHOOP_TOKEN_STORE: store },
		});

		const stderr = await stderrOfOneProfileCall({ store, whoopBaseUrl });

		// The outcome line is info, so it still lands — and every debug line
		// for the same call was written before it, so its arrival proves their
		// absence rather than racing them.
		await vi.waitFor(() => {
			expect(stderr()).toContain("get_profile answered in");
		});

		expect(stderr()).toContain("serving MCP over stdio");
		expect(stderr()).not.toContain("[debug]");
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-logging-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

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
	const client = new Client({ name: "logging-stderr-test", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
			...(env.logLevel ? { WHOOP_LOG_LEVEL: env.logLevel } : {}),
		},
		stderr: "pipe",
	});

	const chunks: Buffer[] = [];
	transport.stderr?.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
	});

	await client.connect(transport);
	try {
		const result = await client.callTool({
			name: "get_profile",
			arguments: {},
		});
		expect(result.isError).not.toBe(true);
	} finally {
		await client.close();
	}

	return () => Buffer.concat(chunks).toString("utf8");
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
	}, 30_000);

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
	}, 30_000);
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
	builtEntry,
	repoRoot,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

const run = promisify(execFile);

/**
 * The host environment minus every `WHOOP_*` variable, plus the ones named, so
 * results do not depend on what the machine running the suite exports.
 */
function environmentWith(
	present: Record<string, string> = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith("WHOOP_")) {
			env[name] = value;
		}
	}

	return { ...env, ...present };
}

/**
 * Runs the built CLI and reports how it ended, with the two streams kept
 * apart: the cases below care which pipe carried what, because under `stdio`
 * one of them is the protocol.
 */
async function runBuilt(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			[builtEntry, ...args],
			{ cwd: repoRoot, env },
		);

		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as {
			code?: number;
			stdout?: string;
			stderr?: string;
		};

		return {
			code: failure.code ?? 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}

describe("a misconfigured environment", () => {
	it("stops `stdio` before it speaks, leaving stdout silent", async () => {
		const { code, stdout, stderr } = await runBuilt(
			[],
			environmentWith({ WHOOP_HTTP_TIMEOUT_MS: "soon" }),
		);

		expect(code).not.toBe(0);
		expect(stderr).toContain("WHOOP_HTTP_TIMEOUT_MS");
		// stdout is the JSON-RPC wire: a refusal must not leave a byte on it.
		expect(stdout).toBe("");
	});

	it("stops `login` before it reaches for the browser", async () => {
		const { code, stderr } = await runBuilt(
			["login"],
			environmentWith({ WHOOP_REDIRECT_URI: "not a url" }),
		);

		expect(code).not.toBe(0);
		expect(stderr).toContain("WHOOP_REDIRECT_URI");
		// The gate answers first: login's own missing-credentials story — the
		// other two variables are absent here — is never reached.
		expect(stderr).not.toContain("WHOOP_CLIENT_ID");
	});

	it("reports an unknown command as usage, ahead of environment problems", async () => {
		const { code, stderr } = await runBuilt(
			["telepathy"],
			environmentWith({ WHOOP_HTTP_TIMEOUT_MS: "soon" }),
		);

		expect(code).not.toBe(0);
		expect(stderr).toMatch(/usage/i);
		expect(stderr).not.toContain("WHOOP_HTTP_TIMEOUT_MS");
	});

	it("still refuses `logout` over a value logout reads", async () => {
		const { code, stderr } = await runBuilt(
			["logout"],
			environmentWith({ WHOOP_API_BASE_URL: "nowhere" }),
		);

		expect(code).not.toBe(0);
		expect(stderr).toContain("WHOOP_API_BASE_URL");
	});

	it("warns about a WHOOP_ name it does not read, then carries on", async () => {
		const { code, stderr } = await runBuilt(
			["login"],
			environmentWith({ WHOOP_TYPO: "surely-a-mistake" }),
		);

		// The warning landed, and login still ran into its own refusal — the
		// stranger is called out without becoming a reason not to work. The
		// proof is a phrase only login says: the warning itself lists every
		// variable this server reads, so a variable name would not show login
		// ran.
		expect(stderr).toContain("WHOOP_TYPO");
		expect(stderr).toContain("Cannot log in to WHOOP");
		expect(code).not.toBe(0);
	});
});

describe("a malformed redirect URI, which serving reads and carries on without", () => {
	it("warns about the in-conversation login it disables, and serves anyway", async () => {
		// Serving reads this variable now — it is where an offered login's
		// loopback listener catches WHOOP's redirect — so a malformed value costs
		// the in-conversation login and nothing else.
		const store = await temporaryStore();
		const stderr = await withBuiltStdioClient(
			{
				store,
				env: { WHOOP_REDIRECT_URI: "not a url" },
				inheritEnvironment: false,
				stderr: "pipe",
			},
			async (client, _transport, stderr) => {
				await expect(client.listTools()).resolves.toBeDefined();

				return stderr;
			},
		);

		await vi.waitFor(() => {
			expect(stderr()).toContain("WHOOP_REDIRECT_URI");
		});
		// The warning has to name the cost: no consent link from inside a
		// conversation while this value does not parse.
		expect(stderr()).toMatch(/inside a conversation/);
		// And not the older claim that only `login` reads it.
		expect(stderr()).not.toContain("only `login` reads");
		expect(stderr()).not.toContain("Cannot start mcp-whoop");
	});

	it("still refuses `login` over the same value, with the checklist unchanged", async () => {
		const { code, stderr } = await runBuilt(
			["login"],
			environmentWith({ WHOOP_REDIRECT_URI: "not a url" }),
		);

		// `login` reaches for a browser with this value in hand, so it stays a
		// hard refusal there, in the same words as before.
		expect(code).not.toBe(0);
		expect(stderr).toContain("Cannot start mcp-whoop");
		expect(stderr).toContain(
			"  - WHOOP_REDIRECT_URI must be the URL WHOOP sends the browser back to",
		);
		// The serving warning names something `login` never had, so it must not
		// appear here.
		expect(stderr).not.toMatch(/inside a conversation/);
	});

	it("says nothing at all when the redirect URI parses", async () => {
		const store = await temporaryStore();
		const stderr = await withBuiltStdioClient(
			{
				store,
				redirectUri: "http://127.0.0.1:8788/callback",
				inheritEnvironment: false,
				stderr: "pipe",
			},
			async (client, _transport, stderr) => {
				await expect(client.listTools()).resolves.toBeDefined();

				return stderr;
			},
		);

		// Serving reading this variable must not turn every ordinary startup into
		// a warning.
		expect(stderr()).not.toContain("WHOOP_REDIRECT_URI");
		expect(stderr()).not.toContain("Ignoring");
	});
});

describe("a login-only variable serving never reads", () => {
	it("leaves serving up, and says so on stderr", async () => {
		// An MCP host reports a server that exits as failed and every tool goes
		// with it, so a value serving can carry on without must not stop startup.
		// Speaking MCP to the built binary is the proof it started.
		const store = await temporaryStore();
		const stderr = await withBuiltStdioClient(
			{
				store,
				env: {
					WHOOP_REDIRECT_URI: "not a url",
					WHOOP_SCOPES: "read:sleep read:sleeep",
				},
				inheritEnvironment: false,
				stderr: "pipe",
			},
			async (client, _transport, stderr) => {
				await expect(client.listTools()).resolves.toBeDefined();

				return stderr;
			},
		);

		// Not stopped by them, not silent about them either.
		await vi.waitFor(() => {
			expect(stderr()).toContain("WHOOP_REDIRECT_URI");
		});
		expect(stderr()).toContain("WHOOP_SCOPES");
		expect(stderr()).toContain("only `login` reads");
		expect(stderr()).not.toContain("Cannot start mcp-whoop");
	});

	it("still refuses `login` over the same values", async () => {
		const { code, stderr } = await runBuilt(
			["login"],
			environmentWith({
				WHOOP_REDIRECT_URI: "not a url",
				WHOOP_SCOPES: "read:sleep read:sleeep",
			}),
		);

		expect(code).not.toBe(0);
		expect(stderr).toContain("Cannot start mcp-whoop");
		expect(stderr).toContain("WHOOP_REDIRECT_URI");
		expect(stderr).toContain("WHOOP_SCOPES");
	});
});

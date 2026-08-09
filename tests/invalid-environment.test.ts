import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";

const run = promisify(execFile);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

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
	}, 30_000);

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
	}, 30_000);

	it("reports an unknown command as usage, ahead of environment problems", async () => {
		const { code, stderr } = await runBuilt(
			["telepathy"],
			environmentWith({ WHOOP_HTTP_TIMEOUT_MS: "soon" }),
		);

		expect(code).not.toBe(0);
		expect(stderr).toMatch(/usage/i);
		expect(stderr).not.toContain("WHOOP_HTTP_TIMEOUT_MS");
	}, 30_000);

	it("still refuses `logout` over a value logout reads", async () => {
		const { code, stderr } = await runBuilt(
			["logout"],
			environmentWith({ WHOOP_API_BASE_URL: "nowhere" }),
		);

		expect(code).not.toBe(0);
		expect(stderr).toContain("WHOOP_API_BASE_URL");
	}, 30_000);

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
	}, 30_000);
});

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-gate-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

describe("a login-only variable serving never reads", () => {
	it("leaves serving up, and says so on stderr", async () => {
		// The whole point of the split: an MCP host reports a server that exits
		// as failed and every tool goes with it, so a redirect URI serving does
		// not consume must not be able to do that. Speaking MCP to the built
		// binary is the proof — it answered, so it started.
		const client = new Client({ name: "environment-gate-test", version: "0" });
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [builtEntry],
			cwd: repoRoot,
			env: {
				WHOOP_TOKEN_STORE: await temporaryStore(),
				WHOOP_REDIRECT_URI: "not a url",
				WHOOP_SCOPES: "read:sleep read:sleeep",
			},
			stderr: "pipe",
		});

		const chunks: Buffer[] = [];
		transport.stderr?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		const stderr = () => Buffer.concat(chunks).toString("utf8");

		await client.connect(transport);
		try {
			await expect(client.listTools()).resolves.toBeDefined();
		} finally {
			await client.close();
		}

		// Not stopped by them, not silent about them either.
		await vi.waitFor(() => {
			expect(stderr()).toContain("WHOOP_REDIRECT_URI");
		});
		expect(stderr()).toContain("WHOOP_SCOPES");
		expect(stderr()).toContain("only `login` reads");
		expect(stderr()).not.toContain("Cannot start mcp-whoop");
	}, 30_000);

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
	}, 30_000);
});

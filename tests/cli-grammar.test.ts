import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** The credentials a WHOOP app supplies through the environment. */
const CREDENTIAL_VARIABLES = [
	"WHOOP_CLIENT_ID",
	"WHOOP_CLIENT_SECRET",
	"WHOOP_REDIRECT_URI",
] as const;

/**
 * An empty directory every connection below is pointed at through
 * `WHOOP_TOKEN_STORE`, so a served instance starts as if never logged in and
 * never reads the real token store of whoever runs the suite.
 */
let emptyTokenStore = "";

beforeAll(async () => {
	emptyTokenStore = await mkdtemp(join(tmpdir(), "mcp-whoop-cli-"));
});

afterAll(async () => {
	if (emptyTokenStore) {
		await rm(emptyTokenStore, { recursive: true, force: true });
	}
});

/**
 * The host environment minus every WHOOP credential, plus the ones named, so
 * results do not depend on whether the machine running the suite exports its
 * own application's credentials.
 */
function environmentWith(
	present: Partial<Record<(typeof CREDENTIAL_VARIABLES)[number], string>> = {},
): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of CREDENTIAL_VARIABLES) {
		delete env[name];
	}

	return { ...env, ...present };
}

/**
 * Runs the built CLI the way a user would and reports how it ended. Both
 * streams come back as one string, since the assertions care that the user was
 * told something, not which pipe carried it.
 */
async function runCli(
	args: string[],
	env: NodeJS.ProcessEnv = environmentWith(),
): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			[builtEntry, ...args],
			{ cwd: repoRoot, env },
		);

		return { code: 0, output: stdout + stderr };
	} catch (error) {
		const failure = error as {
			code?: number;
			stdout?: string;
			stderr?: string;
		};

		return {
			code: failure.code ?? 1,
			output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
		};
	}
}

/**
 * Connects a real MCP client to the built entry point invoked with the given
 * arguments, and reports what the handshake and a tool listing yielded. The
 * transport owns the child process, so closing the client is what reaps it —
 * hence the `finally`.
 */
async function serveOver(
	args: string[],
): Promise<{ name?: string; tools: string[] }> {
	const client = new Client({ name: "cli-grammar-test", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry, ...args],
		cwd: repoRoot,
		env: { WHOOP_TOKEN_STORE: emptyTokenStore },
	});

	await client.connect(transport);
	try {
		return {
			name: client.getServerVersion()?.name,
			tools: (await client.listTools()).tools.map((tool) => tool.name),
		};
	} finally {
		await client.close();
	}
}

describe("the built CLI", () => {
	it("serves MCP over stdio when no subcommand is given", async () => {
		const served = await serveOver([]);

		expect(served.name).toBe("mcp-whoop");
		expect(served.tools).toContain("get_profile");
	}, 30_000);

	it("serves MCP over stdio through the explicit `stdio` argument", async () => {
		const served = await serveOver(["stdio"]);

		expect(served).toEqual(await serveOver([]));
		expect(served.tools).toContain("get_profile");
	}, 30_000);

	it("fails `login` naming every credential the environment lacks", async () => {
		const { code, output } = await runCli(["login"]);

		expect(code).not.toBe(0);
		for (const name of CREDENTIAL_VARIABLES) {
			expect(output).toContain(name);
		}
	}, 30_000);

	it("names only the credential `login` is actually missing", async () => {
		const { code, output } = await runCli(
			["login"],
			environmentWith({
				WHOOP_CLIENT_ID: "client-id",
				WHOOP_CLIENT_SECRET: "client-secret",
			}),
		);

		expect(code).not.toBe(0);
		expect(output).toContain("WHOOP_REDIRECT_URI");
		expect(output).not.toContain("WHOOP_CLIENT_ID");
		expect(output).not.toContain("WHOOP_CLIENT_SECRET");
	}, 30_000);

	it("fails an unknown subcommand with usage listing the commands", async () => {
		const { code, output } = await runCli(["telepathy"]);

		expect(code).not.toBe(0);
		expect(output).toMatch(/usage/i);
		expect(output).toContain("login");
	}, 30_000);
});

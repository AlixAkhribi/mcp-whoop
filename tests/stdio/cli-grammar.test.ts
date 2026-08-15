import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
	builtEntry,
	repoRoot,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

const run = promisify(execFile);

/** The credentials a WHOOP app supplies through the environment. */
const CREDENTIAL_VARIABLES = [
	"WHOOP_CLIENT_ID",
	"WHOOP_CLIENT_SECRET",
	"WHOOP_REDIRECT_URI",
] as const;

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
	const store = await temporaryStore();

	return withBuiltStdioClient({ args, store }, async (client) => {
		return {
			name: client.getServerVersion()?.name,
			tools: (await client.listTools()).tools.map((tool) => tool.name),
		};
	});
}

describe("the built CLI", () => {
	it("serves MCP over stdio when no subcommand is given", async () => {
		const served = await serveOver([]);

		expect(served.name).toBe("mcp-whoop");
		expect(served.tools).toContain("get_profile");
	});

	it("serves MCP over stdio through the explicit `stdio` argument", async () => {
		const served = await serveOver(["stdio"]);

		expect(served).toEqual(await serveOver([]));
		expect(served.tools).toContain("get_profile");
	});

	it("fails `login` naming every credential the environment lacks", async () => {
		const { code, output } = await runCli(["login"]);

		expect(code).not.toBe(0);
		for (const name of CREDENTIAL_VARIABLES) {
			expect(output).toContain(name);
		}
	});

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
	});

	it("fails an unknown subcommand with usage listing the commands", async () => {
		const { code, output } = await runCli(["telepathy"]);

		expect(code).not.toBe(0);
		expect(output).toMatch(/usage/i);
		expect(output).toContain("login");
	});
});

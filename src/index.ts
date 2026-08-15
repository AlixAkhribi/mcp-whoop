#!/usr/bin/env node

/**
 * @file Dispatches on the first CLI argument, importing only the module that
 * argument selects so serving MCP never loads the login command and vice versa.
 */

import type { Command } from "@/config/environment";

/**
 * Defaults to serving MCP over stdio, which is what an MCP client spawns.
 * `stdio` is accepted as an explicit argument too, since a client
 * configuration may name the transport it wants rather than rely on the
 * default.
 */
const command = process.argv[2] ?? "stdio";

/** Usage text. `stdio` is accepted but undocumented: nothing new needs it. */
const USAGE = [
	"Usage: mcp-whoop [command]",
	"",
	"Commands:",
	"  (none)  Serve the WHOOP MCP server over stdio, for an MCP client to spawn",
	"  login   Authorize this server with your WHOOP account",
	"  logout  Revoke this server's WHOOP access and forget the stored login",
].join("\n");

/**
 * The commands this binary answers to. Typed as {@link Command} so the gate
 * below is asked about a command it knows the read surface of — a new command
 * here has to be given one there before it compiles.
 */
const COMMANDS = [
	"stdio",
	"login",
	"logout",
] as const satisfies readonly Command[];

/** Whether the argument names a command, narrowing it when it does. */
function isCommand(value: string): value is Command {
	return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Refusals set `process.exitCode` and return rather than calling
 * `process.exit`, which can outrun its own diagnostic: writes to a piped
 * stderr are asynchronous on Windows, and an MCP client reads this server
 * through pipes. With nothing else scheduled, the process exits on its own
 * once the report has flushed.
 */
async function run(): Promise<void> {
	if (!isCommand(command)) {
		console.error(`Unknown command: ${command}`);
		console.error(USAGE);
		process.exitCode = 1;

		return;
	}

	// The environment gate sits between the command check and the dispatch: a
	// mistyped command is an invocation mistake and reads as usage, but a value
	// the environment misdescribes must stop the commands that read it before
	// they act on it. It is asked about this command in particular, so a
	// login-only variable cannot take serving down. Both reports go to stderr —
	// under `stdio`, stdout belongs to the protocol from the first byte.
	const { environmentProblems, environmentWarnings } = await import(
		"@/config/environment"
	);

	const problems = environmentProblems(process.env, command);

	if (problems) {
		console.error(problems);
		process.exitCode = 1;

		return;
	}

	const warnings = environmentWarnings(process.env, command);

	if (warnings) {
		console.error(warnings);
	}

	switch (command) {
		case "stdio":
			await import("@/transports/stdio");
			break;
		case "login": {
			const { runLogin } = await import("@/whoop/auth/login");
			process.exitCode = await runLogin();
			break;
		}
		case "logout": {
			const { runLogout } = await import("@/whoop/auth/logout");
			process.exitCode = await runLogout();
			break;
		}
	}
}

await run();

#!/usr/bin/env node

/**
 * @file Dispatches on the first CLI argument, importing only the module that
 * argument selects so serving MCP never loads the login command and vice versa.
 */

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

switch (command) {
	case "stdio":
		await import("@/transports/stdio");
		break;
	case "login": {
		const { runLogin } = await import("@/auth/login");
		process.exitCode = await runLogin();
		break;
	}
	case "logout": {
		const { runLogout } = await import("@/auth/logout");
		process.exitCode = await runLogout();
		break;
	}
	default:
		console.error(`Unknown command: ${command}`);
		console.error(USAGE);
		process.exit(1);
}

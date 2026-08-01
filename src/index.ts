#!/usr/bin/env node

/**
 * Launcher: picks a transport by first CLI argument and imports only that
 * module, so no other transport initializes. stdio is the default and — for
 * now — the only one; the switch is the seam where streamable HTTP would
 * slot in.
 */
const transport = process.argv[2] ?? "stdio";

switch (transport) {
	case "stdio":
		await import("./transports/stdio.js");
		break;
	default:
		console.error(`Unknown transport: ${transport}`);
		console.error("Available transports: stdio");
		process.exit(1);
}

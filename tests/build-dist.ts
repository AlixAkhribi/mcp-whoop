import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tscBin = fileURLToPath(
	new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);

/**
 * Builds `dist/` once for the whole run. Several suites drive the *built*
 * artifact — the same thing a real MCP host spawns, and the same thing that
 * gets packed — and building per suite would race two compilers on one output
 * directory.
 */
export default async function buildDist(): Promise<void> {
	await run(process.execPath, [tscBin], { cwd: repoRoot });
}

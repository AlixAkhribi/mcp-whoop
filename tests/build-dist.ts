import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const require = createRequire(import.meta.url);
const tsdownManifest = require("tsdown/package.json") as {
	bin: { tsdown: string };
};

/**
 * The real `tsdown` entry point, taken from its own manifest: the
 * `node_modules/.bin` entries are per-platform shell shims that
 * `process.execPath` cannot run.
 */
const tsdownBin = join(
	dirname(require.resolve("tsdown/package.json")),
	tsdownManifest.bin.tsdown,
);

/**
 * Builds `dist/` once for the whole run. Several suites drive the *built*
 * artifact — the same thing a real MCP host spawns, and the same thing that
 * gets packed — and building per suite would race two bundlers on one output
 * directory.
 */
export default async function buildDist(): Promise<void> {
	await run(process.execPath, [tsdownBin], { cwd: repoRoot });
}

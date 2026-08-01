import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runFile = promisify(execFile);
const runShell = promisify(exec);

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const isWindows = process.platform === "win32";

/** The bin name this package is published under (ADR 0001). */
const BIN_NAME = "mcp-whoop";

/**
 * npm ships these whatever `files` says, so they are the only entries a
 * tarball may carry besides the built output.
 */
const alwaysPacked = /^(package\.json|README|LICENSE|LICENCE|CHANGELOG)($|\.)/i;

/**
 * Runs a CLI the way a consumer would. On Windows `npm` is a `.cmd` shim,
 * which Node refuses to spawn without a shell, so the command is assembled as
 * a string there — arguments quoted against spaces, the command name left bare
 * because a quoted one makes `cmd.exe` resolve the shim's `%~dp0` to the
 * working directory. Elsewhere the argv form needs no quoting at all.
 */
async function runCli(
	command: string,
	args: string[],
	cwd: string,
): Promise<{ stdout: string }> {
	const options = { cwd, maxBuffer: 32 * 1024 * 1024 };

	return isWindows
		? runShell(`${command} ${args.map((arg) => `"${arg}"`).join(" ")}`, options)
		: runFile(command, args, options);
}

let scratch = "";
let tarball = "";
let installedPackage = "";

/**
 * Packs a real tarball from the built project and installs it into a throwaway
 * consumer project, so every assertion below sees what npm would publish and
 * what `npx mcp-whoop` would run.
 */
beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mcp-whoop-pack-"));
	const { stdout } = await runCli(
		"npm",
		["pack", repoRoot, "--silent"],
		scratch,
	);
	tarball = join(scratch, stdout.trim().split(/\r?\n/).at(-1) ?? "");

	const consumer = join(scratch, "consumer");
	await mkdir(consumer);
	await writeFile(
		join(consumer, "package.json"),
		JSON.stringify({ name: "consumer", version: "0.0.0", private: true }),
		"utf8",
	);
	await runCli(
		"npm",
		["install", "--no-audit", "--no-fund", "--prefer-offline", tarball],
		consumer,
	);
	installedPackage = join(consumer, "node_modules", BIN_NAME);
}, 300_000);

afterAll(async () => {
	if (scratch) {
		await rm(scratch, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	}
});

/** Paths inside the tarball, with the `package/` wrapper stripped. */
async function tarballEntries(): Promise<string[]> {
	const { stdout } = await runCli("tar", ["-tzf", basename(tarball)], scratch);

	return stdout
		.split(/\r?\n/)
		.filter((entry) => entry && !entry.endsWith("/"))
		.map((entry) => entry.replace(/^package\//, ""))
		.sort();
}

/** The text of one member of the tarball, without extracting it to disk. */
async function tarballMember(path: string): Promise<string> {
	const { stdout } = await runCli(
		"tar",
		["-xzOf", basename(tarball), `package/${path}`],
		scratch,
	);

	return stdout;
}

/** The manifest of the package as it was installed from the tarball. */
async function installedManifest(): Promise<{ bin?: Record<string, string> }> {
	return JSON.parse(
		await readFile(join(installedPackage, "package.json"), "utf8"),
	) as { bin?: Record<string, string> };
}

/**
 * Connects a real MCP client to a script over stdio. The transport owns the
 * child process, so closing the client is what reaps it — hence the `finally`.
 */
async function withClient<T>(
	entry: string,
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({ name: "packaged-bin-test", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [entry],
		cwd: dirname(entry),
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

describe("the packed and installed package", () => {
	it("greets over stdio through the bin it declares", async () => {
		const { bin } = await installedManifest();
		expect(bin?.[BIN_NAME]).toEqual(expect.any(String));

		const entry = resolve(installedPackage, bin?.[BIN_NAME] ?? "");
		expect(await readFile(entry, "utf8")).toMatch(
			/^#!\/usr\/bin\/env node\r?\n/,
		);

		const { tools, greeting } = await withClient(entry, async (client) => ({
			tools: (await client.listTools()).tools.map((tool) => tool.name),
			greeting: await client.callTool({
				name: "hello",
				arguments: { name: "Ada" },
			}),
		}));

		expect(tools).toContain("hello");
		expect(greeting.isError).toBeFalsy();
		expect(greeting.content).toEqual([
			{ type: "text", text: expect.stringContaining("Ada") },
		]);
	}, 60_000);

	it("ships the built output and nothing a consumer cannot use", async () => {
		const packed = JSON.parse(await tarballMember("package.json")) as {
			name: string;
		};
		const entries = await tarballEntries();

		expect(packed.name).toBe(BIN_NAME);
		expect(entries).toContain("dist/index.js");
		expect(
			entries.filter(
				(entry) => !(alwaysPacked.test(entry) || entry.startsWith("dist/")),
			),
		).toEqual([]);
	}, 60_000);
});

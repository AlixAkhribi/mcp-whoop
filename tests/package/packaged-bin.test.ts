import { exec, execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runFile = promisify(execFile);
const runShell = promisify(exec);

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const isWindows = process.platform === "win32";

/** The bin name this package is published under — not the repository name. */
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
 * The archive `npm pack` just wrote into the scratch directory, found by
 * looking rather than by reading the filename off stdout. npm runs `prepare`
 * before packing and lets it share the stream, so anything that script prints
 * lands there too — husky's `HUSKY=0 skip install` notice, which CI provokes
 * and which carries no trailing newline, would otherwise be glued to the front
 * of the name. The directory is made fresh above and holds exactly one `.tgz`.
 */
async function packedTarball(): Promise<string> {
	const [archive, ...extras] = (await readdir(scratch)).filter((entry) =>
		entry.endsWith(".tgz"),
	);
	if (!archive || extras.length > 0) {
		throw new Error(
			`expected one packed tarball in ${scratch}, found ${archive ? 1 + extras.length : 0}`,
		);
	}

	return archive;
}

/**
 * Packs a real tarball from the built project and installs it into a throwaway
 * consumer project, so every assertion below sees what npm would publish and
 * what `npx mcp-whoop` would run.
 */
beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mcp-whoop-pack-"));
	await runCli("npm", ["pack", repoRoot, "--silent"], scratch);
	tarball = join(scratch, await packedTarball());

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
 * The host environment minus every WHOOP credential, pointed at a scratch
 * token store, so the installed bin sees a machine that has never logged in
 * and never reads the real login of whoever runs the suite.
 */
function freshMachineEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WHOOP_TOKEN_STORE: join(scratch, "token-store"),
	};
	for (const name of [
		"WHOOP_CLIENT_ID",
		"WHOOP_CLIENT_SECRET",
		"WHOOP_REDIRECT_URI",
	]) {
		delete env[name];
	}

	return env;
}

/**
 * Runs the installed bin the way `npx mcp-whoop <args>` would and reports how
 * it ended. Both streams come back as one string, since the assertions care
 * that the user was told something, not which pipe carried it.
 */
async function runInstalledBin(
	entry: string,
	args: string[],
): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await runFile(
			process.execPath,
			[entry, ...args],
			{
				cwd: scratch,
				env: freshMachineEnvironment(),
			},
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
		env: { WHOOP_TOKEN_STORE: join(scratch, "token-store") },
		stderr: "ignore",
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

describe("the packed and installed package", () => {
	it("serves the WHOOP tools over stdio through the bin it declares", async () => {
		const { bin } = await installedManifest();
		expect(bin?.[BIN_NAME]).toEqual(expect.any(String));

		const entry = resolve(installedPackage, bin?.[BIN_NAME] ?? "");
		expect(await readFile(entry, "utf8")).toMatch(
			/^#!\/usr\/bin\/env node\r?\n/,
		);

		const { tools, profile } = await withClient(entry, async (client) => ({
			tools: (await client.listTools()).tools.map((tool) => tool.name),
			profile: await client.callTool({
				name: "get_profile",
				arguments: {},
			}),
		}));

		expect(tools).toContain("get_profile");
		expect(profile.isError).toBe(true);
		expect(JSON.stringify(profile.content)).toContain("npx mcp-whoop login");
	}, 60_000);

	it("validates the login environment from the installed package", async () => {
		const { bin } = await installedManifest();
		const entry = resolve(installedPackage, bin?.[BIN_NAME] ?? "");

		const { code, output } = await runInstalledBin(entry, ["login"]);

		// A machine that runs `login` before setting any variables is told
		// exactly which ones it is missing, not merely that something is wrong.
		expect(code).not.toBe(0);
		expect(output).toContain("WHOOP_CLIENT_ID");
		expect(output).toContain("WHOOP_CLIENT_SECRET");
		expect(output).toContain("WHOOP_REDIRECT_URI");
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

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * An empty directory every connection below is pointed at through
 * `WHOOP_TOKEN_STORE`, so the server always starts as if never logged in and
 * never reads the real token store of whoever runs the suite.
 */
let emptyTokenStore = "";

beforeAll(async () => {
	emptyTokenStore = await mkdtemp(join(tmpdir(), "mcp-whoop-store-"));
});

afterAll(async () => {
	if (emptyTokenStore) {
		await rm(emptyTokenStore, { recursive: true, force: true });
	}
});

/**
 * Connects a real MCP client to the built entry point over stdio. The
 * transport owns the child process, so closing the client is what reaps it —
 * hence the `finally`.
 */
async function withClient<T>(use: (client: Client) => Promise<T>): Promise<T> {
	const client = new Client({
		name: "whoop-tools-stdio-test",
		version: "0.0.0",
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: { WHOOP_TOKEN_STORE: emptyTokenStore },
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

/**
 * Calls a tool and reduces the two shapes a failure can take — a rejected
 * promise or a resolved `isError` result — to one record, so a test can assert
 * on the failure text without pinning down which shape the SDK chose.
 */
async function callTool(
	client: Client,
	name: string,
): Promise<{ failed: boolean; text: string }> {
	try {
		const result = await client.callTool({ name, arguments: {} });

		return {
			failed: result.isError === true,
			text: JSON.stringify(result.content),
		};
	} catch (error) {
		return { failed: true, text: String(error) };
	}
}

describe("the built server over real stdio", () => {
	it("declares the package name and the manifest version", async () => {
		const identity = await withClient(async (client) =>
			client.getServerVersion(),
		);

		expect(identity).toMatchObject({
			name: "mcp-whoop",
			version: manifest.version,
		});
	}, 30_000);

	it("advertises get_profile with a description and an input schema", async () => {
		const { tools } = await withClient((client) => client.listTools());

		const tool = tools.find((candidate) => candidate.name === "get_profile");
		expect(tool?.description).toEqual(expect.any(String));
		expect(tool?.description).not.toBe("");
		expect(tool?.inputSchema.type).toBe("object");
	}, 30_000);

	it("fails get_profile with the login command when nothing is stored", async () => {
		const outcome = await withClient((client) =>
			callTool(client, "get_profile"),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("npx mcp-whoop login");
	}, 30_000);

	it("keeps serving the same connection after get_profile fails", async () => {
		const { failure, afterwards } = await withClient(async (client) => ({
			failure: await callTool(client, "get_profile"),
			afterwards: await client.listTools(),
		}));

		expect(failure.failed).toBe(true);
		expect(afterwards.tools.map((tool) => tool.name)).toContain("get_profile");
	}, 30_000);

	it("advertises the WHOOP data tools and nothing else", async () => {
		const { tools } = await withClient((client) => client.listTools());

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"get_body_measurements",
			"get_profile",
		]);
	}, 30_000);
});

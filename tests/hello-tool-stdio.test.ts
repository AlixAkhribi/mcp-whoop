import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * Connects a real MCP client to the built entry point over stdio. The
 * transport owns the child process, so closing the client is what reaps it —
 * hence the `finally`.
 */
async function withClient<T>(use: (client: Client) => Promise<T>): Promise<T> {
	const client = new Client({
		name: "hello-tool-stdio-test",
		version: "0.0.0",
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

/**
 * Normalises the two shapes a failed `tools/call` can take — a rejected
 * promise or a resolved `isError` result — into one boolean, so a test can
 * assert "this call failed" without pinning down which shape the SDK chose.
 */
async function callFailed(
	call: Promise<{ isError?: boolean }>,
): Promise<boolean> {
	try {
		return (await call).isError === true;
	} catch {
		return true;
	}
}

/** The content a successful `hello` call must produce for `name`. */
function greetingFor(name: string): unknown {
	return [{ type: "text", text: expect.stringContaining(name) }];
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

	it("advertises exactly one hello tool with a described name input", async () => {
		const { tools } = await withClient((client) => client.listTools());

		expect(tools).toHaveLength(1);
		const [tool] = tools;
		expect(tool?.name).toBe("hello");
		expect(tool?.description).toEqual(expect.any(String));
		expect(tool?.inputSchema.type).toBe("object");
		expect(tool?.inputSchema.properties?.name).toMatchObject({
			type: "string",
			description: "Who to greet",
		});
	}, 30_000);

	it("greets the name it is called with", async () => {
		const result = await withClient((client) =>
			client.callTool({ name: "hello", arguments: { name: "Ada" } }),
		);

		expect(result.isError).toBeFalsy();
		expect(result.content).toEqual(greetingFor("Ada"));
	}, 30_000);

	it("rejects a call without a name and stays usable afterwards", async () => {
		const outcomes = await withClient(async (client) => ({
			missing: await callFailed(
				client.callTool({ name: "hello", arguments: {} }),
			),
			recovered: await client.callTool({
				name: "hello",
				arguments: { name: "Ada" },
			}),
		}));

		expect(outcomes.missing).toBe(true);
		expect(outcomes.recovered.isError).toBeFalsy();
		expect(outcomes.recovered.content).toEqual(greetingFor("Ada"));
	}, 30_000);
});

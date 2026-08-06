import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { registerTools } from "@/tools";

const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));

/**
 * The two tools the README's authentication walkthrough already covers — the
 * identity pair the login surface shipped with. Everything else the server
 * registers is a data tool, and is what this file holds the README to.
 */
const AUTHENTICATION_TOOLS = ["get_profile", "get_body_measurements"];

/**
 * The tool names this server actually advertises, in the canonical order it
 * advertises them, taken from the registrations themselves over a real
 * client/server pair rather than from a list written down here: the surface is
 * the source of truth, so a tool that lands without documentation fails these
 * cases instead of quietly drifting past them.
 */
async function advertisedToolNames(): Promise<string[]> {
	const server = new McpServer({
		name: "readme-data-surface-test",
		version: "0.0.0",
	});
	// No granted scopes to narrow by: the whole surface, as a full login sees it.
	registerTools(server);

	const client = new Client({
		name: "readme-data-surface-test",
		version: "0.0.0",
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	try {
		return (await client.listTools()).tools.map((tool) => tool.name);
	} finally {
		await client.close();
		await server.close();
	}
}

/** The data tools: the advertised surface minus the authentication pair. */
async function dataToolNames(): Promise<string[]> {
	return (await advertisedToolNames()).filter(
		(name) => !AUTHENTICATION_TOOLS.includes(name),
	);
}

/**
 * What one README heading covers: every line under it, up to the next heading
 * of the same or a higher level. Reading a named section rather than the whole
 * file is what makes these cases about the data-surface documentation, not
 * about a tool name happening to appear somewhere else in the document.
 */
function section(readme: string, heading: string): string {
	const lines = readme.split(/\r?\n/);
	const opens = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "i");
	const start = lines.findIndex((line) => opens.test(line));
	if (start === -1) {
		throw new Error(`the README has no "${heading}" heading`);
	}

	const depth = (lines[start].match(/^#+/) ?? [""])[0].length;
	const below = lines.slice(start + 1);
	const ends = below.findIndex((line) => {
		const hashes = line.match(/^(#+)\s/);

		return hashes !== null && hashes[1].length <= depth;
	});

	return (ends === -1 ? below : below.slice(0, ends)).join("\n");
}

describe("the README's data-surface documentation", () => {
	it("names every data tool the server serves", async () => {
		const readme = await readFile(readmePath, "utf8");
		const documented = section(readme, "Data tools");

		const names = await dataToolNames();

		expect(names).toHaveLength(12);
		for (const name of names) {
			expect(documented, `${name} is undocumented`).toContain(`\`${name}\``);
		}
	});

	it("states the day-equals-cycle rule and the bounds a summary's days argument takes", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Summary tools");

		// A day is WHOOP's, not the calendar's — the rule every summary is read
		// through, and the one a model would otherwise guess wrong.
		expect(documented).toMatch(/physiological cycle/i);
		expect(documented).toMatch(/wake to wake/i);
		expect(documented).toMatch(/never a calendar date/i);
		// The range a summary takes, both bounds and the default it assumes.
		expect(documented).toContain("`days`");
		expect(documented).toMatch(/1\s*(?:[–-]|to)\s*30/);
		expect(documented).toMatch(/default 7|7 by default/i);
	});
});

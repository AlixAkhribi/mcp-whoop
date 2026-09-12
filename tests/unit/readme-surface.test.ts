import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { registerResources } from "@/resources";
import { registerTools } from "@/tools";

const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));

/**
 * The two tools the README's authentication walkthrough already covers — the
 * identity pair the login surface shipped with. Everything else the server
 * registers is a data tool, and is what this file holds the README to.
 */
const IDENTITY_TOOLS = ["get_profile", "get_body_measurements"];

/**
 * Puts one set of registrations on a fresh server and asks a real client what
 * it was advertised, over an in-memory pair. Every surface below is read this
 * way rather than from a list written down here: the registrations are the
 * source of truth, so a tool or a resource that lands without documentation
 * fails these cases instead of quietly drifting past them.
 */
async function advertised<T>(
	register: (server: McpServer) => void,
	ask: (client: Client) => Promise<T>,
): Promise<T> {
	const server = new McpServer({
		name: "readme-surface-test",
		version: "0.0.0",
	});
	// No granted scopes to narrow by: the whole surface, as a full login sees it.
	register(server);

	const client = new Client({
		name: "readme-surface-test",
		version: "0.0.0",
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	try {
		return await ask(client);
	} finally {
		await client.close();
		await server.close();
	}
}

/** The tool names, in the canonical order this server advertises them. */
async function advertisedToolNames(): Promise<string[]> {
	return advertised(registerTools, async (client) =>
		(await client.listTools()).tools.map((tool) => tool.name),
	);
}

/** The data tools: the advertised surface minus the authentication pair. */
async function dataToolNames(): Promise<string[]> {
	return (await advertisedToolNames()).filter(
		(name) => !IDENTITY_TOOLS.includes(name),
	);
}

/** The resource URIs, in the canonical order this server advertises them. */
async function advertisedResourceUris(): Promise<string[]> {
	return advertised(registerResources, async (client) =>
		(await client.listResources()).resources.map((resource) => resource.uri),
	);
}

/**
 * The template patterns, in the canonical order this server advertises them —
 * read from `resources/templates/list`, the listing the plain resource set
 * never folds a family into, so a template that lands without documentation
 * fails below the same way an undocumented resource does.
 */
async function advertisedTemplatePatterns(): Promise<string[]> {
	return advertised(registerResources, async (client) =>
		(await client.listResourceTemplates()).resourceTemplates.map(
			(template) => template.uriTemplate,
		),
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

		for (const name of names) {
			expect(documented, `${name} is undocumented`).toContain(`\`${name}\``);
		}
	});

	it("states the day-equals-cycle rule and the bounds a summary's days argument takes", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Summary tools");

		// A day is WHOOP's, not the calendar's — the rule every summary is read
		// through, and the one a model would otherwise guess wrong. It is named by
		// the morning the user woke into it, never by the evening the cycle began:
		// the onset WHOOP bounds a cycle at is a boundary, not a label.
		expect(documented).toMatch(/physiological cycle/i);
		expect(documented).toMatch(/woke|wake day/i);
		expect(documented).toMatch(/never a calendar date/i);
		expect(documented).not.toMatch(/wake to wake/i);
		// The range a summary takes, both bounds and the default it assumes.
		expect(documented).toContain("`days`");
		expect(documented).toMatch(/1\s*(?:[–-]|to)\s*30/);
		expect(documented).toMatch(/default 7|7 by default/i);
	});

	it("states which day a sleep is filed under", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Summary tools");

		// A night crossing midnight belongs to the morning it ends on, not to the
		// evening it began — the half of the rule a reader of the sleep digest
		// needs, since every night they see is filed by its wake.
		expect(documented).toMatch(
			/a\s+sleep\s+belongs\s+to\s+the\s+(?:morning|day)\s+it\s+ends/i,
		);
	});

	it("names the one-day shift the wake-day labels moved most rows by", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Summary tools");

		// The wake-day rule moved most rows' dates forward a day. Someone comparing a
		// summary against output they kept from an earlier release reads a
		// changed date here rather than filing it as changed numbers.
		expect(documented).toMatch(
			/(?:forward\s+(?:by\s+)?one\s+day|one\s+day\s+later|a\s+day\s+later)/i,
		);
		expect(documented).toMatch(/earlier\s+release|used\s+to|previously/i);
	});
});

describe("the README's resource-surface documentation", () => {
	it("names every resource the server serves", async () => {
		const readme = await readFile(readmePath, "utf8");
		const documented = section(readme, "Resources");

		const uris = await advertisedResourceUris();

		for (const uri of uris) {
			expect(documented, `${uri} is undocumented`).toContain(`\`${uri}\``);
		}
	});

	it("names every resource template the server serves", async () => {
		const readme = await readFile(readmePath, "utf8");
		const documented = section(readme, "Resources");

		const patterns = await advertisedTemplatePatterns();

		// The enumeration itself is load-bearing: an empty answer would let every
		// pattern below pass vacuously, documenting nothing.
		expect(patterns).not.toHaveLength(0);
		for (const pattern of patterns) {
			expect(documented, `${pattern} is undocumented`).toContain(
				`\`${pattern}\``,
			);
		}
	});

	it("shows an example day URI and says which day a date names", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Resources");

		// A pattern tells nobody what to type; an example member does. And the
		// date in it is the wake day — the morning the user woke, the date the
		// WHOOP app shows — the same rule every summary is read through, which
		// is the one thing a person must know before typing one.
		expect(documented).toMatch(/whoop:\/\/day\/\d{4}-\d{2}-\d{2}/);
		expect(documented).toMatch(/woke|wake day/i);
	});

	it("describes the date completion and names the template-listing command", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Resources");

		// How the variable is filled in: the client completes it, offered the
		// recent wake days newest first — the order WHOOP lists and the summaries
		// report — narrowed by what was typed so far. And where the family itself
		// is found: `resources/templates/list`, since it never joins the plain
		// listing a picker shows whole.
		expect(documented).toMatch(/complet/i);
		expect(documented).toMatch(/newest first/i);
		expect(documented).toContain("resources/templates/list");
	});

	it("states that the listing stands whole and the granted scopes gate each read", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Resources");

		// The two rules that explain a refused read: the listing never narrows —
		// the 2026-07-28 revision forbids it varying with connection state — and
		// the grant is judged when a read runs, so a reader refused a scope
		// learns why here rather than filing a bug.
		expect(documented).toMatch(
			/resource list is identical whatever the login/i,
		);
		expect(documented).toMatch(/granted scopes gate each read/i);
		expect(documented).toMatch(/refused read names the missing scopes/i);
	});

	it("describes the login offer beside the refusal rules", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Resources");

		// The third thing a refused read can mean: no login at all, which is
		// answered with a consent link rather than prose — under the same
		// one-decline policy the tools follow. Documented in the same section as
		// the scope refusals, so a reader met by either knows which they got.
		expect(documented).toMatch(/consent/i);
	});

	it("states the snapshot model a read of a resource follows", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Resources");

		// What a client may expect of a resource here: a snapshot it re-reads when
		// it wants freshness, never a stream it is fed. A client told otherwise
		// would sit waiting for an update this server has no way to send. And the
		// reuse lifetime every read declares — none — since a re-login can swap
		// the account a cached copy belongs to without the client seeing a thing.
		expect(documented).toMatch(/snapshot/i);
		expect(documented).toMatch(/re-?reads?[^.]*fresh/i);
		expect(documented).toMatch(/never pushes updates/i);
		expect(documented).toContain("`ttlMs: 0`");
	});

	it("walks through browsing the surface with the MCP inspector", async () => {
		const readme = await readFile(readmePath, "utf8");

		const documented = section(readme, "Resources");

		expect(documented).toMatch(/inspector/i);
		// Both of the repo's own scripts, since neither browses alone: the web UI
		// a person clicks through, and the CLI that asks the same two questions
		// without a browser.
		expect(documented).toMatch(/pnpm inspect\s/);
		expect(documented).toContain("pnpm inspect:cli");
		// The two steps the walk is made of: list what this login is served, then
		// read one of the URIs that came back.
		expect(documented).toContain("resources/list");
		expect(documented).toContain("resources/read");
	});
});

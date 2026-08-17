import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_LOGIN_TTL_MS,
	DEFAULT_LOGIN_WAIT_MS,
} from "@/config/elicited-login";

const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
const examplePath = fileURLToPath(
	new URL("../../.env.example", import.meta.url),
);

/** One README paragraph as a single line, so wrapped sentences still match. */
function paragraph(readme: string, containing: string): string {
	const found = readme
		.split(/\r?\n[ \t]*\r?\n/)
		.find((block) => block.includes(containing));
	if (found === undefined) {
		throw new Error(`the README has no paragraph containing "${containing}"`);
	}

	return found.replaceAll(/\s+/g, " ").trim();
}

/**
 * The comment block directly above a variable's assignment in `.env.example`,
 * hashes stripped, read as one line. Stops at a commented-out assignment,
 * which documents itself rather than the variable below.
 */
function commentAbove(example: string, name: string): string {
	const lines = example.split(/\r?\n/);
	const at = lines.findIndex((line) => line.startsWith(`${name}=`));
	if (at === -1) {
		throw new Error(`the environment example does not set ${name}`);
	}

	const said: string[] = [];
	for (
		let above = at - 1;
		above >= 0 &&
		lines[above].startsWith("#") &&
		!/^#\s*\w+=/.test(lines[above]);
		above -= 1
	) {
		said.unshift(lines[above].replace(/^#\s?/, ""));
	}

	return said.join(" ").replaceAll(/\s+/g, " ").trim();
}

describe("the environment documentation", () => {
	it("says WHOOP_REDIRECT_URI is read by serving too, not by the login command alone", async () => {
		const [readme, example] = await Promise.all([
			readFile(readmePath, "utf8"),
			readFile(examplePath, "utf8"),
		]);

		const gate = paragraph(readme, "validated at startup");
		expect(gate).toContain("`WHOOP_SCOPES` is read by `login` alone");
		// Serving now reads the redirect URI; the README must not call it
		// login-only.
		expect(gate).toContain("`WHOOP_REDIRECT_URI` is read by serving too");
		expect(gate).not.toMatch(/`WHOOP_REDIRECT_URI`[^.]*`login` alone/);

		// `.env.example` must say the same where the variable is set.
		const documented = commentAbove(example, "WHOOP_REDIRECT_URI");
		expect(documented).toMatch(/serving/i);
		expect(documented).toMatch(/inside a conversation/i);
		expect(example).not.toMatch(/serving needs none of them/i);
	});

	it("names the login wait budget and attempt lifetime, and the defaults they fall back to", async () => {
		const [readme, example] = await Promise.all([
			readFile(readmePath, "utf8"),
			readFile(examplePath, "utf8"),
		]);

		const said = paragraph(readme, "WHOOP_LOGIN_WAIT_MS");
		expect(said).toContain("`WHOOP_LOGIN_TTL_MS`");
		expect(said).toContain(String(DEFAULT_LOGIN_WAIT_MS));
		expect(said).toContain(String(DEFAULT_LOGIN_TTL_MS));

		expect(example).toContain(`#WHOOP_LOGIN_WAIT_MS=${DEFAULT_LOGIN_WAIT_MS}`);
		expect(example).toContain(`#WHOOP_LOGIN_TTL_MS=${DEFAULT_LOGIN_TTL_MS}`);
	});
});

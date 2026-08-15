import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	callToolOutcome,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

const manifest = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * The tools that take no arguments at all: whose data is read follows from the
 * stored login, and which day "today" is follows from WHOOP.
 */
const PARAMETERLESS_TOOLS = [
	"get_profile",
	"get_body_measurements",
	"get_today_snapshot",
];

/**
 * What an argument no tool takes is sent carrying, spelled distinctively so a
 * case can tell whether the refusal quoted it. Naming the key a model got wrong
 * is the whole point of the error; repeating what was inside it is not, since
 * the next argument spelled wrong could be holding anything at all.
 */
const UNKNOWN_ARGUMENT_VALUE = "should-never-echo-1234";

const TOOL_ARGUMENTS: ReadonlyArray<
	readonly [name: string, args: Record<string, unknown>]
> = [
	["get_profile", {}],
	["get_body_measurements", {}],
	["list_cycles", { limit: 1 }],
	["get_cycle", { cycleId: 1 }],
	["list_sleeps", { limit: 1 }],
	["get_sleep", { sleepId: "00000000-0000-4000-8000-000000000001" }],
	["get_cycle_sleep", { cycleId: 1 }],
	["list_recoveries", { limit: 1 }],
	["get_cycle_recovery", { cycleId: 1 }],
	["list_workouts", { limit: 1 }],
	["get_workout", { workoutId: "00000000-0000-4000-8000-000000000001" }],
	["get_sleep_summary", { days: 7 }],
	["get_recovery_summary", { days: 7 }],
	["get_today_snapshot", {}],
];

describe("the built server over real stdio", () => {
	it("declares the package name and the manifest version", async () => {
		const store = await temporaryStore();
		const identity = await withBuiltStdioClient({ store }, async (client) =>
			client.getServerVersion(),
		);

		expect(identity).toMatchObject({
			name: "mcp-whoop",
			version: manifest.version,
		});
	});

	it("advertises get_profile with a description and an input schema", async () => {
		const store = await temporaryStore();
		const { tools } = await withBuiltStdioClient({ store }, (client) =>
			client.listTools(),
		);

		const tool = tools.find((candidate) => candidate.name === "get_profile");
		expect(tool?.description).toEqual(expect.any(String));
		expect(tool?.description).not.toBe("");
		expect(tool?.inputSchema.type).toBe("object");
	});

	it("advertises the parameterless tools as taking no properties at all", async () => {
		const store = await temporaryStore();
		const { tools } = await withBuiltStdioClient({ store }, (client) =>
			client.listTools(),
		);

		for (const name of PARAMETERLESS_TOOLS) {
			const schema = tools.find(
				(candidate) => candidate.name === name,
			)?.inputSchema;

			expect(schema?.type).toBe("object");
			// The shape the specification recommends for a tool with no
			// parameters, so a model reads the closed door before walking into it.
			expect(schema?.additionalProperties).toBe(false);
		}
	});

	it("advertises every tool input as closed to unknown properties", async () => {
		const store = await temporaryStore();
		const { tools } = await withBuiltStdioClient({ store }, (client) =>
			client.listTools(),
		);

		expect(tools).toHaveLength(TOOL_ARGUMENTS.length);
		for (const tool of tools) {
			expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
		}
	});

	it.each(TOOL_ARGUMENTS)(
		"refuses an unknown property on %s",
		async (name, args) => {
			const store = await temporaryStore();
			const outcome = await withBuiltStdioClient({ store }, (client) =>
				callToolOutcome(client, name, {
					...args,
					unexpected: UNKNOWN_ARGUMENT_VALUE,
				}),
			);

			expect(outcome.rejected).toBe(false);
			expect(outcome.failed).toBe(true);
			expect(outcome.text).toContain("Input validation error");
			expect(outcome.text).toContain("unexpected");
			expect(outcome.text).not.toContain(UNKNOWN_ARGUMENT_VALUE);
		},
	);

	it("fails get_profile with the login command when nothing is stored", async () => {
		const store = await temporaryStore();
		const outcome = await withBuiltStdioClient({ store }, (client) =>
			callToolOutcome(client, "get_profile"),
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("npx mcp-whoop login");
		// Sending nothing is still a valid call: what the closed schema refuses is
		// an unknown key, not the empty object these tools are asked with.
		expect(outcome.text).not.toContain("Input validation error");
	});

	it("keeps serving the same connection after get_profile fails", async () => {
		const store = await temporaryStore();
		const { failure, afterwards } = await withBuiltStdioClient(
			{ store },
			async (client) => ({
				failure: await callToolOutcome(client, "get_profile"),
				afterwards: await client.listTools(),
			}),
		);

		expect(failure.failed).toBe(true);
		expect(afterwards.tools.map((tool) => tool.name)).toContain("get_profile");
	});

	it("advertises the WHOOP data tools and nothing else", async () => {
		const store = await temporaryStore();
		const { tools } = await withBuiltStdioClient({ store }, (client) =>
			client.listTools(),
		);

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"get_body_measurements",
			"get_cycle",
			"get_cycle_recovery",
			"get_cycle_sleep",
			"get_profile",
			"get_recovery_summary",
			"get_sleep",
			"get_sleep_summary",
			"get_today_snapshot",
			"get_workout",
			"list_cycles",
			"list_recoveries",
			"list_sleeps",
			"list_workouts",
		]);
	});
});

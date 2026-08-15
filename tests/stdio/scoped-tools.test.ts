import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The measurements the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const MEASUREMENTS = {
	height_meter: 1.65,
	weight_kilogram: 57.6,
	max_heart_rate: 198,
};

/** The profile the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** One request the stand-in WHOOP was asked to serve. */
type WhoopRequest = {
	method: string;
	path: string;
	authorization: string | undefined;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/** How the stand-in WHOOP answers each data path it knows. */
const ANSWERS: Record<string, unknown> = {
	"/developer/v2/user/measurement/body": MEASUREMENTS,
	"/developer/v2/user/profile/basic": PROFILE,
};

const GRANT_CASES = [
	{
		label: "profile",
		granted: ["read:profile"],
		visible: ["get_profile"],
	},
	{
		label: "body measurements",
		granted: ["read:body_measurement"],
		visible: ["get_body_measurements"],
	},
	{
		label: "cycles",
		granted: ["read:cycles"],
		visible: ["get_cycle", "list_cycles"],
	},
	{
		label: "sleep",
		granted: ["read:sleep"],
		visible: [
			"get_cycle_sleep",
			"get_sleep",
			"get_sleep_summary",
			"list_sleeps",
		],
	},
	{
		label: "recovery",
		granted: ["read:recovery"],
		visible: ["get_cycle_recovery", "list_recoveries"],
	},
	{
		label: "workouts",
		granted: ["read:workout"],
		visible: ["get_workout", "list_workouts"],
	},
	{
		label: "recovery summary",
		granted: ["read:cycles", "read:recovery"],
		visible: [
			"get_cycle",
			"get_cycle_recovery",
			"get_recovery_summary",
			"list_cycles",
			"list_recoveries",
		],
	},
	{
		label: "today snapshot",
		granted: ["read:cycles", "read:recovery", "read:sleep"],
		visible: [
			"get_cycle",
			"get_cycle_recovery",
			"get_cycle_sleep",
			"get_recovery_summary",
			"get_sleep",
			"get_sleep_summary",
			"get_today_snapshot",
			"list_cycles",
			"list_recoveries",
			"list_sleeps",
		],
	},
] as const;

/**
 * A stand-in WHOOP serving the v2 data endpoints and recording every request,
 * so a case can assert what was actually sent upstream.
 */
async function startFakeWhoop(): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://whoop.invalid").pathname;
		requests.push({
			method: request.method ?? "",
			path,
			authorization: request.headers.authorization,
		});
		request.resume();
		request.on("end", () => {
			const answer = ANSWERS[path];
			response.writeHead(answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP.
 */

describe("granted scopes shaping the tool surface, over real stdio", () => {
	it("serves body measurements as structured content when every scope was granted", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { names, result } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				names: (await client.listTools()).tools.map((tool) => tool.name),
				result: await client.callTool({
					name: "get_body_measurements",
					arguments: {},
				}),
			}),
		);

		expect(names).toContain("get_body_measurements");
		expect(whoop.requests).toContainEqual({
			method: "GET",
			path: "/developer/v2/user/measurement/body",
			authorization: "Bearer an-access-token",
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(MEASUREMENTS);
	});

	it.each(GRANT_CASES)(
		"registers exactly the $label tools its grant allows",
		async ({ granted, visible }) => {
			const store = await temporaryStore();
			await seedStore(store, granted);

			const names = await withBuiltStdioClient({ store }, async (client) =>
				(await client.listTools()).tools.map((tool) => tool.name).sort(),
			);

			expect(names).toEqual([...visible].sort());
		},
	);

	it("enforces a narrower grant on an already-registered tool before contacting WHOOP", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const outcome = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => {
				const names = (await client.listTools()).tools.map((tool) => tool.name);
				expect(names).toContain("get_profile");

				await seedStore(store, ["read:body_measurement"]);

				return client
					.callTool({ name: "get_profile", arguments: {} })
					.then((result) => ({
						failed: result.isError === true,
						text: JSON.stringify(result.content),
					}))
					.catch((error: unknown) => ({ failed: true, text: String(error) }));
			},
		);

		expect(outcome.failed).toBe(true);
		expect(outcome.text).toContain("read:profile");
		expect(outcome.text).toContain("npx mcp-whoop login");
		expect(whoop.requests).toEqual([]);
	});

	it("serves the full default surface when never logged in, and calls fail with the login command", async () => {
		const whoop = await startFakeWhoop();
		const store = await temporaryStore();

		const { names, outcomes } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			async (client) => ({
				names: (await client.listTools()).tools.map((t) => t.name),
				outcomes: await Promise.all(
					["get_profile", "get_body_measurements"].map((name) =>
						client
							.callTool({ name, arguments: {} })
							.then((result) => ({
								failed: result.isError === true,
								text: JSON.stringify(result.content),
							}))
							.catch((error: unknown) => ({
								failed: true,
								text: String(error),
							})),
					),
				),
			}),
		);

		expect(names).toContain("get_profile");
		expect(names).toContain("get_body_measurements");
		for (const outcome of outcomes) {
			expect(outcome.failed).toBe(true);
			expect(outcome.text).toContain("npx mcp-whoop login");
		}
	});
});

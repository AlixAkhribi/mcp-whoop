import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** Starts a loopback server and reports the origin it ended up on. */
async function listenOnLoopback(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	opened.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	);

	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-whoop-today-snapshot-"));
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** The offset every seeded record carries — WHOOP's own `±HH:MM` form. */
const TIMEZONE_OFFSET = "-05:00";

/**
 * Today's cycle in WHOOP's own v2 shape: the newest one, still running —
 * `end: null`, an explicit null rather than an absent field (observed
 * 2026-08-02) — and scored while it runs, so its strain is the strain so far.
 */
const OPEN_CYCLE = {
	id: 93_845,
	user_id: 10_129,
	created_at: "2026-08-04T11:25:44.774Z",
	updated_at: "2026-08-04T14:25:44.774Z",
	start: "2026-08-04T10:25:44.774Z",
	end: null,
	timezone_offset: TIMEZONE_OFFSET,
	score_state: "SCORED",
	score: {
		strain: 5.2951527,
		kilojoule: 8288.297,
		average_heart_rate: 68,
		max_heart_rate: 141,
	},
};

/**
 * Yesterday's cycle, closed — the second record of the listing, and the one a
 * snapshot reaching for the wrong end of the page would report instead.
 */
const CLOSED_CYCLE = {
	...OPEN_CYCLE,
	id: 93_844,
	created_at: "2026-08-03T11:25:44.774Z",
	updated_at: "2026-08-03T14:25:44.774Z",
	start: "2026-08-03T10:25:44.774Z",
	end: "2026-08-04T10:25:44.774Z",
};

/**
 * The night that started today's cycle, in WHOOP's own v2 shape — naming that
 * cycle back as its `cycle_id`, the way WHOOP's records do.
 */
const ONSET_SLEEP = {
	id: "ecfc6a15-4661-442f-a9a4-f1621ee1a0f6",
	cycle_id: OPEN_CYCLE.id,
	v1_id: null,
	user_id: 10_129,
	created_at: "2026-08-04T10:26:44.774Z",
	updated_at: "2026-08-04T10:30:44.774Z",
	start: "2026-08-04T02:25:44.774Z",
	end: "2026-08-04T10:25:44.774Z",
	timezone_offset: TIMEZONE_OFFSET,
	nap: false,
	score_state: "SCORED",
	score: {
		stage_summary: {
			total_in_bed_time_milli: 28_800_000,
			total_awake_time_milli: 1_800_000,
			total_no_data_time_milli: 0,
			total_light_sleep_time_milli: 13_500_000,
			total_slow_wave_sleep_time_milli: 6_750_000,
			total_rem_sleep_time_milli: 6_750_000,
			sleep_cycle_count: 4,
			disturbance_count: 6,
		},
		sleep_needed: {
			baseline_milli: 27_395_716,
			need_from_sleep_debt_milli: 352_230,
			need_from_recent_strain_milli: 208_595,
			need_from_recent_nap_milli: -12_312,
		},
		respiratory_rate: 16.113_281_25,
		sleep_performance_percentage: 98,
		sleep_consistency_percentage: 90,
		sleep_efficiency_percentage: 93.75,
	},
};

/** The recovery WHOOP scored for today's cycle, off that night. */
const SCORED_RECOVERY = {
	cycle_id: OPEN_CYCLE.id,
	sleep_id: ONSET_SLEEP.id,
	user_id: 10_129,
	created_at: "2026-08-04T10:30:44.774Z",
	updated_at: "2026-08-04T10:35:44.774Z",
	score_state: "SCORED",
	score: {
		user_calibrating: false,
		recovery_score: 44,
		resting_heart_rate: 64,
		hrv_rmssd_milli: 31.813_562,
		spo2_percentage: 95.6875,
		skin_temp_celsius: 33.7,
	},
};

/** One request the stand-in WHOOP was asked to serve. */
type WhoopRequest = {
	method: string;
	path: string;
	query: Record<string, string>;
	authorization: string | undefined;
};

/**
 * What the stand-in WHOOP holds behind today's cycle joins: a record, or
 * `null` for the 404 WHOOP answers when it has nothing to join.
 */
type Joins = {
	recovery: Record<string, unknown> | null;
	sleep: Record<string, unknown> | null;
};

type FakeWhoop = {
	/** What `WHOOP_API_BASE_URL` is pointed at. */
	readonly baseUrl: string;
	/** Every request this WHOOP received, in order. */
	readonly requests: WhoopRequest[];
};

/**
 * How the stand-in WHOOP answers: the cycle listing newest first — today's
 * open cycle at its head — and each join of that cycle, or nothing at all when
 * the case seeded the join empty.
 */
function answerFor(url: URL, joins: Joins): unknown {
	if (url.pathname === "/developer/v2/cycle") {
		return { records: [OPEN_CYCLE, CLOSED_CYCLE], next_token: null };
	}
	if (url.pathname === `/developer/v2/cycle/${OPEN_CYCLE.id}/recovery`) {
		return joins.recovery ?? undefined;
	}
	if (url.pathname === `/developer/v2/cycle/${OPEN_CYCLE.id}/sleep`) {
		return joins.sleep ?? undefined;
	}

	return undefined;
}

/**
 * A stand-in WHOOP serving the v2 cycle listing and the two joins hanging off
 * today's cycle, and recording every request — query string included — so a
 * case can assert what was actually sent upstream.
 */
async function startFakeWhoop(joins: Joins): Promise<FakeWhoop> {
	const requests: WhoopRequest[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://whoop.invalid");
		requests.push({
			method: request.method ?? "",
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: request.headers.authorization,
		});
		request.resume();
		request.on("end", () => {
			const answer = answerFor(url, joins);
			response.writeHead(answer === undefined ? 404 : 200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(answer ?? {}));
		});
	});

	return { baseUrl: await listenOnLoopback(server), requests };
}

/** Every read scope WHOOP defines — what a default login is granted. */
const ALL_READ_SCOPES = [
	"read:profile",
	"read:body_measurement",
	"read:cycles",
	"read:sleep",
	"read:recovery",
	"read:workout",
];

/** The three reads a snapshot of today is made of, as scopes. */
const SNAPSHOT_SCOPES = ["read:cycles", "read:recovery", "read:sleep"];

/** The listing each of those scopes buys on its own. */
const LISTING_OF_SCOPE: Record<string, string> = {
	"read:cycles": "list_cycles",
	"read:recovery": "list_recoveries",
	"read:sleep": "list_sleeps",
};

/** Seeds a store with a live login that was granted the given scopes. */
async function seedStore(store: string, scopes: string[]): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes,
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP.
 */
async function withClient<T>(
	env: { store: string; whoopBaseUrl: string },
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({
		name: "today-snapshot-stdio-test",
		version: "0.0.0",
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: env.store,
			WHOOP_API_BASE_URL: env.whoopBaseUrl,
		},
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

describe("the today snapshot over real stdio", () => {
	it("answers today's open cycle, its recovery and its onset sleep in one call", async () => {
		const whoop = await startFakeWhoop({
			recovery: SCORED_RECOVERY,
			sleep: ONSET_SLEEP,
		});
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_today_snapshot", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		// Both joins are addressed by the open cycle at the head of the listing —
		// not the closed one behind it — under the stored login.
		for (const path of [
			"/developer/v2/cycle",
			`/developer/v2/cycle/${OPEN_CYCLE.id}/recovery`,
			`/developer/v2/cycle/${OPEN_CYCLE.id}/sleep`,
		]) {
			expect(whoop.requests).toContainEqual(
				expect.objectContaining({
					method: "GET",
					path,
					authorization: "Bearer an-access-token",
				}),
			);
		}
		expect(result.structuredContent).toEqual({
			// The cycle still running, carrying the strain it has accumulated so far.
			cycle: OPEN_CYCLE,
			recovery_state: "SCORED",
			recovery: SCORED_RECOVERY,
			sleep: ONSET_SLEEP,
		});
		// The sleep names the cycle it belongs to, so the snapshot's three records
		// stay joinable after a model has carried only the sleep away.
		expect(
			(result.structuredContent as { sleep: Record<string, unknown> }).sleep,
		).toMatchObject({ cycle_id: OPEN_CYCLE.id });
	}, 30_000);

	it("reports the recovery as absent when its join answers 404, not as an error", async () => {
		// WHOOP holds no recovery for today's cycle — the answer a morning before
		// the recovery lands, and an answer about today rather than a failure.
		const whoop = await startFakeWhoop({ recovery: null, sleep: ONSET_SLEEP });
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_today_snapshot", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			cycle: OPEN_CYCLE,
			// Absence said as a state of the day, and the rest of the day still told.
			recovery_state: "ABSENT",
			recovery: null,
			sleep: ONSET_SLEEP,
		});
	}, 30_000);

	it("reports the sleep as null when its join answers 404, carrying the rest", async () => {
		// WHOOP has no sleep to hang on today's cycle — a night it never recorded,
		// which is a fact about today, not a broken read.
		const whoop = await startFakeWhoop({
			recovery: SCORED_RECOVERY,
			sleep: null,
		});
		const store = await temporaryStore();
		await seedStore(store, [...ALL_READ_SCOPES, "offline"]);

		const result = await withClient(
			{ store, whoopBaseUrl: whoop.baseUrl },
			(client) =>
				client.callTool({ name: "get_today_snapshot", arguments: {} }),
		);

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			cycle: OPEN_CYCLE,
			recovery_state: "SCORED",
			recovery: SCORED_RECOVERY,
			sleep: null,
		});
	}, 30_000);

	it("hides get_today_snapshot unless all three of its scopes were granted", async () => {
		const whoop = await startFakeWhoop({
			recovery: SCORED_RECOVERY,
			sleep: ONSET_SLEEP,
		});

		for (const missing of SNAPSHOT_SCOPES) {
			const granted = SNAPSHOT_SCOPES.filter((scope) => scope !== missing);
			const store = await temporaryStore();
			// A grant that reaches two of the three reads the snapshot makes: it
			// would only buy a tool that fails on the read it was not allowed to
			// make, so it is not served at all.
			await seedStore(store, [...granted, "offline"]);

			const names = await withClient(
				{ store, whoopBaseUrl: whoop.baseUrl },
				async (client) => (await client.listTools()).tools.map((t) => t.name),
			);

			expect(names).not.toContain("get_today_snapshot");
			// What each granted scope buys on its own is still there.
			for (const kept of granted) {
				expect(names).toContain(LISTING_OF_SCOPE[kept]);
			}
		}
	}, 30_000);
});

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

/** Where the body measurements are addressed — the resource this suite is about. */
const BODY_MEASUREMENTS_URI = "whoop://body-measurements";

/** The resource that came before it, and that it is listed directly after. */
const PROFILE_URI = "whoop://profile";

/** The first of the curated set, ahead of both. */
const TODAY_URI = "whoop://today";

/** The two listed after it — what a grant losing one scope must leave standing. */
const RECOVERY_LAST_WEEK_URI = "whoop://recovery/last-week";
const SLEEP_LAST_WEEK_URI = "whoop://sleep/last-week";

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
	const directory = await mkdtemp(
		join(tmpdir(), "mcp-whoop-body-measurements-resource-"),
	);
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

/** The measurements the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const BODY_MEASUREMENT = {
	height_meter: 1.8034,
	weight_kilogram: 74.6,
	max_heart_rate: 191,
};

/** A stand-in WHOOP holding one user's body measurements. */
async function startFakeWhoop(): Promise<string> {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			const known = pathname === "/developer/v2/user/measurement/body";
			response.writeHead(known ? 200 : 404, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(known ? BODY_MEASUREMENT : {}));
		});
	});

	return listenOnLoopback(server);
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

/** Seeds a store with a live login that was granted the given scopes. */
async function seedStore(store: string, scopes: string[]): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: "an-access-token",
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes: [...scopes, "offline"],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * Connects a real MCP client to the built entry point over stdio — a separate
 * server process, exactly what an MCP host spawns — pointed at the given token
 * store and stand-in WHOOP.
 *
 * The revision is pinned rather than probed, as it is everywhere resources are
 * driven: reads carry cache hints and a URI this server serves nothing at is
 * refused as invalid params under the 2026-07-28 contract, so a pin fails
 * loudly instead of quietly falling back to an era that answered otherwise.
 */
async function withClient<T>(
	env: { store: string; whoopBaseUrl: string },
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client(
		{ name: "body-measurements-resource-stdio-test", version: "0.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
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

/**
 * Where a case's WHOOP would be, if a case needed one: nothing listens there.
 * A case gating on the recorded grant does not — which resources exist is
 * decided from the stored login alone, before any request is made — and
 * pointing the server at a dead port is what proves it.
 */
const NO_WHOOP_BASE_URL = "http://127.0.0.1:1";

/** The JSON-RPC error a refused read comes back as. */
type Refusal = { code: number; message: string; data?: unknown };

/**
 * Reads a resource that is meant to fail, and reduces the rejection to the
 * JSON-RPC error the client was answered with. A read that succeeds is itself
 * the failure: the case asked for a grant this server may not act on to be
 * refused, not answered.
 */
async function refusedRead(client: Client, uri: string): Promise<Refusal> {
	try {
		await client.readResource({ uri });
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(`reading ${uri} was answered rather than refused`);
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

describe("the body measurements as a resource, over real stdio", () => {
	it("answers a read with the very text its tool answers with", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ALL_READ_SCOPES);

		const { called, read } = await withClient(
			{ store, whoopBaseUrl },
			async (client) => ({
				called: await client.callTool({
					name: "get_body_measurements",
					arguments: {},
				}),
				read: await client.readResource({ uri: BODY_MEASUREMENTS_URI }),
			}),
		);

		// One item, not a bundle: the resource is one person's measurements.
		expect(read.contents).toHaveLength(1);
		expect(read.contents[0]).toMatchObject({
			uri: BODY_MEASUREMENTS_URI,
			mimeType: "application/json",
		});
		// Byte-identical, not merely equivalent: the two surfaces answer the one
		// canonical rendering of the measurements, so neither can drift from the
		// other.
		expect(textOf(read.contents[0])).toBe(
			textOf((called.content as unknown[])[0]),
		);
	}, 30_000);

	it("lists whoop://body-measurements straight after whoop://profile, self-described", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ALL_READ_SCOPES);

		const { resources } = await withClient({ store, whoopBaseUrl }, (client) =>
			client.listResources(),
		);

		// The place this one holds in the order a user's picker shows them:
		// directly after whose day it is, never ahead of it and never with
		// anything wedged between the two. What the whole curated set is, entry
		// for entry, is the last-listed resource's case to make.
		const uris = resources.map((resource) => resource.uri);
		expect(uris).toContain(PROFILE_URI);
		expect(uris.indexOf(BODY_MEASUREMENTS_URI)).toBe(
			uris.indexOf(PROFILE_URI) + 1,
		);

		const listed = resources.find(
			(resource) => resource.uri === BODY_MEASUREMENTS_URI,
		);
		expect(listed).toBeDefined();
		expect(listed).toMatchObject({
			uri: BODY_MEASUREMENTS_URI,
			name: "whoop_body_measurements",
			title: "WHOOP body measurements",
			mimeType: "application/json",
			// Both audiences and nothing else: a person picks it out of a list, and
			// the model it is handed to has to know whose body it is reading.
			annotations: { audience: ["user", "assistant"] },
		});
		// Exactly those two, in that order — `toMatchObject` would be satisfied by
		// a third audience nobody meant to address.
		expect(listed?.annotations?.audience).toEqual(["user", "assistant"]);
		// Self-describing: what is in the card, in the words someone would use to
		// ask for it, rather than the endpoint it is read from.
		expect(listed?.description).toMatch(/height/i);
		expect(listed?.description).toMatch(/weight/i);
	}, 30_000);

	it("still lists whoop://body-measurements but refuses its read for a grant lacking read:body_measurement", async () => {
		const store = await temporaryStore();
		// Everything but the one scope the measurement read takes: what this grant
		// cannot buy is exactly one read, and nothing beside it.
		await seedStore(
			store,
			ALL_READ_SCOPES.filter((scope) => scope !== "read:body_measurement"),
		);

		const { uris, refusal } = await withClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			async (client) => ({
				uris: (await client.listResources()).resources.map(
					(resource) => resource.uri,
				),
				refusal: await refusedRead(client, BODY_MEASUREMENTS_URI),
			}),
		);

		// The listing may not follow the grant — the 2026-07-28 revision forbids
		// `resources/list` varying with connection state, and the stored grant is
		// exactly that — so all five entries stand, and the read is where this
		// login is told what it may not do: the scope it is missing, and the
		// command that grants it. Decided from the store alone — the dead WHOOP
		// port proves nothing was asked upstream.
		expect(uris).toEqual([
			TODAY_URI,
			PROFILE_URI,
			BODY_MEASUREMENTS_URI,
			RECOVERY_LAST_WEEK_URI,
			SLEEP_LAST_WEEK_URI,
		]);
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("read:body_measurement");
		expect(refusal.message).toContain("npx mcp-whoop login");
	}, 30_000);

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store, ALL_READ_SCOPES);

		const result = await withClient({ store, whoopBaseUrl }, (client) =>
			client.readResource({ uri: BODY_MEASUREMENTS_URI }),
		);

		// Zero — immediately stale — though a height and a weight barely change:
		// the answer is bound to whoever the stored login belongs to, a re-login
		// can swap that account under an unchanged URI, and this server has no
		// way to call a cached copy back. Private: it describes one person's
		// body.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	}, 30_000);
});

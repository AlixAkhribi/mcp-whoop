import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { writeStoredTokens } from "@/auth/tokens/store";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** The snapshot resource these cases read — the one wanting three scopes. */
const TODAY_URI = "whoop://today";

/**
 * Every resource this server serves, in the canonical order `resources/list`
 * advertises: the 2026-07-28 revision has the listing name what is currently
 * available and forbids it varying with connection state, and the stored grant
 * is connection-time state — so the listing is this, whole, for every login,
 * and what a grant may not read is refused at the read itself.
 */
const ALL_RESOURCE_URIS = [
	"whoop://today",
	"whoop://profile",
	"whoop://body-measurements",
	"whoop://recovery/last-week",
	"whoop://sleep/last-week",
];

/**
 * Where a case's WHOOP would be, if a case needed one: nothing listens there.
 * None of these cases does — a refusal for a scope the login was not granted
 * is decided from the stored login alone, before any request is made — and
 * pointing the server at a dead port is what proves it, since anything that
 * did reach for WHOOP would fail loudly here rather than quietly leaving the
 * machine.
 */
const NO_WHOOP_BASE_URL = "http://127.0.0.1:1";

/** Everything a case opened, torn down after it in reverse order. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of opened.splice(0).reverse()) {
		await close();
	}
});

/** A throwaway directory for one case's token store. */
async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(
		join(tmpdir(), "mcp-whoop-scoped-resources-"),
	);
	opened.push(() => rm(directory, { recursive: true, force: true }));

	return directory;
}

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
 * store.
 *
 * The revision is pinned rather than probed, as it is everywhere resources are
 * driven: the 2026-07-28 contract is the one whose listing rule these cases
 * assert, and a pin fails loudly instead of quietly falling back to an era
 * that answered some other way.
 */
async function withClient<T>(
	store: string,
	use: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client(
		{ name: "scoped-resources-stdio-test", version: "0.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [builtEntry],
		cwd: repoRoot,
		env: {
			WHOOP_TOKEN_STORE: store,
			WHOOP_API_BASE_URL: NO_WHOOP_BASE_URL,
		},
	});

	await client.connect(transport);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

/** The URIs `resources/list` advertises to a client on this store. */
async function listedUris(store: string): Promise<string[]> {
	return withClient(store, async (client) =>
		(await client.listResources()).resources.map((resource) => resource.uri),
	);
}

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

/**
 * The three scopes today's snapshot is assembled from: it answers a cycle, the
 * recovery scored for it and the sleep that started it, all at once.
 */
const SNAPSHOT_SCOPES = ["read:cycles", "read:recovery", "read:sleep"];

/**
 * Every way a login can be granted two of those three, named by the one it
 * lacks — each combination a case of its own, since a refusal can be wrong
 * about one scope while being right about the others.
 */
const MISSING_ONE = SNAPSHOT_SCOPES.map((missing) => ({
	missing,
	granted: SNAPSHOT_SCOPES.filter((scope) => scope !== missing),
}));

describe("the resource listing standing whole over any grant, over real stdio", () => {
	it.each(MISSING_ONE)(
		"still lists every resource for a login granted everything but $missing",
		async ({ granted }) => {
			const store = await temporaryStore();
			await seedStore(store, [...granted, "offline"]);

			// The listing may not follow the grant: the grant is connection-time
			// state, and the revision forbids `resources/list` varying with it.
			// What this login may not read is the read's own refusal to give.
			expect(await listedUris(store)).toEqual(ALL_RESOURCE_URIS);
		},
		30_000,
	);

	it("lists every resource when nothing is logged in at all", async () => {
		// An empty store: no login, and so no grant to judge any read by yet.
		const store = await temporaryStore();

		// The full surface: absence of a login hides nothing, or a user who has
		// not logged in yet would meet a picker that says nothing about what this
		// server is for. The read itself is what names the login command.
		expect(await listedUris(store)).toEqual(ALL_RESOURCE_URIS);
	}, 30_000);

	it("lists every resource for a grant that may read none of them", async () => {
		const store = await temporaryStore();
		// A real grant, and not one any of the five resources can be answered
		// from: workouts are a surface of their own, with no resource hanging
		// off them.
		await seedStore(store, ["read:workout", "offline"]);

		const { capabilities, uris } = await withClient(store, async (client) => ({
			capabilities: client.getServerCapabilities(),
			uris: (await client.listResources()).resources.map(
				(resource) => resource.uri,
			),
		}));

		// The capability and the whole listing, even here: what this grant may
		// not do is read, and each read says so itself.
		expect(capabilities?.resources).toBeDefined();
		expect(uris).toEqual(ALL_RESOURCE_URIS);
	}, 30_000);
});

describe("the granted scopes judging each resource read, over real stdio", () => {
	it("refuses a read of whoop://today by naming the scope the login lacks", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:cycles", "read:recovery", "offline"]);

		const refusal = await withClient(store, (client) =>
			refusedRead(client, TODAY_URI),
		);

		// This server's own refusal, not the protocol library's unknown-URI
		// answer: the resource exists and the request was well-formed — the
		// stored grant simply may not read it — so it comes back as the internal
		// error a failed read is, carrying the scope that is missing and the one
		// way to grant it. Decided from the store alone: the dead WHOOP port
		// proves nothing was asked upstream.
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("read:sleep");
		expect(refusal.message).toContain("npx mcp-whoop login");
	}, 30_000);

	it("names every missing scope when the grant covers none of a read", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:workout", "offline"]);

		const refusal = await withClient(store, (client) =>
			refusedRead(client, TODAY_URI),
		);

		expect(refusal.code).toBe(-32603);
		// All three, not merely the first found wanting: a user re-running the
		// login learns the whole of what it has to grant in one refusal.
		for (const scope of SNAPSHOT_SCOPES) {
			expect(refusal.message).toContain(scope);
		}
		expect(refusal.message).toContain("npx mcp-whoop login");
	}, 30_000);

	it("judges a read by the store as it stands, not as the connection began", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:cycles", "read:recovery", "offline"]);

		const refusals = await withClient(store, async (client) => {
			const before = await refusedRead(client, TODAY_URI);
			// The login redone mid-connection — the state a startup snapshot of
			// the grant would never see. The dead WHOOP port keeps the case
			// honest: the newly granted read now fails reaching WHOOP, which is
			// exactly the proof it was allowed to try.
			await seedStore(store, [...SNAPSHOT_SCOPES, "offline"]);
			const after = await refusedRead(client, TODAY_URI);

			return { before, after };
		});

		expect(refusals.before.message).toContain("read:sleep");
		// No longer the grant's refusal: the re-read store allows the read, and
		// what fails now is WHOOP being unreachable — a different failure with a
		// different message, reached without restarting the connection.
		expect(refusals.after.message).not.toContain("read:sleep");
		expect(refusals.after.message).toContain("WHOOP could not be reached");
	}, 30_000);
});

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

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

/** The URIs `resources/list` advertises to a client on this store. */
async function listedUris(store: string): Promise<string[]> {
	return withBuiltStdioClient(
		{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
		async (client) =>
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

const RESOURCE_SCOPE_CASES = [
	{
		uri: "whoop://profile",
		granted: ["read:workout"],
		missing: ["read:profile"],
	},
	{
		uri: "whoop://body-measurements",
		granted: ["read:profile"],
		missing: ["read:body_measurement"],
	},
	{
		uri: "whoop://recovery/last-week",
		granted: ["read:cycles"],
		missing: ["read:recovery"],
	},
	{
		uri: "whoop://sleep/last-week",
		granted: ["read:cycles"],
		missing: ["read:sleep"],
	},
] as const;

describe("the resource listing standing whole over any grant, over real stdio", () => {
	it("keeps the complete canonical listing under a narrowed grant", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:cycles", "read:recovery"]);

		expect(await listedUris(store)).toEqual(ALL_RESOURCE_URIS);
	});

	it("lists every resource when nothing is logged in at all", async () => {
		// An empty store: no login, and so no grant to judge any read by yet.
		const store = await temporaryStore();

		// The full surface: absence of a login hides nothing, or a user who has
		// not logged in yet would meet a picker that says nothing about what this
		// server is for. The read itself is what names the login command.
		expect(await listedUris(store)).toEqual(ALL_RESOURCE_URIS);
	});

	it("lists every resource for a grant that may read none of them", async () => {
		const store = await temporaryStore();
		// A real grant, and not one any resource can be answered
		// from: workouts are a surface of their own, with no resource hanging
		// off them.
		await seedStore(store, ["read:workout"]);

		const { capabilities, listing } = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			async (client) => ({
				capabilities: client.getServerCapabilities(),
				listing: await client.listResources(),
			}),
		);

		// The capability and the whole listing, even here: what this grant may
		// not do is read, and each read says so itself.
		expect(capabilities?.resources).toBeDefined();
		expect(capabilities?.resources).not.toHaveProperty("subscribe");
		expect(capabilities?.resources?.listChanged).not.toBe(true);
		expect(listing.resources.map((resource) => resource.uri)).toEqual(
			ALL_RESOURCE_URIS,
		);
		expect(listing.ttlMs).toBe(3_600_000);
		expect(listing.cacheScope).toBe("private");
	});
});

describe("the granted scopes judging each resource read, over real stdio", () => {
	it("refuses a read of whoop://today by naming the scope the login lacks", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:cycles", "read:recovery"]);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => refusedRead(client, TODAY_URI),
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
	});

	it.each(RESOURCE_SCOPE_CASES)(
		"refuses $uri with its missing granted scope",
		async ({ uri, granted, missing }) => {
			const store = await temporaryStore();
			await seedStore(store, granted);

			const refusal = await withBuiltStdioClient(
				{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
				(client) => refusedRead(client, uri),
			);

			expect(refusal.code).toBe(-32603);
			for (const scope of missing) {
				expect(refusal.message).toContain(scope);
			}
			expect(refusal.message).toContain("npx mcp-whoop login");
		},
	);

	it("names every missing scope when the grant covers none of a read", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:workout"]);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => refusedRead(client, TODAY_URI),
		);

		expect(refusal.code).toBe(-32603);
		// All three, not merely the first found wanting: a user re-running the
		// login learns the whole of what it has to grant in one refusal.
		for (const scope of SNAPSHOT_SCOPES) {
			expect(refusal.message).toContain(scope);
		}
		expect(refusal.message).toContain("npx mcp-whoop login");
	});

	it("judges a read by the store as it stands, not as the connection began", async () => {
		const store = await temporaryStore();
		await seedStore(store, ["read:cycles", "read:recovery"]);

		const refusals = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			async (client) => {
				const before = await refusedRead(client, TODAY_URI);
				// The login redone mid-connection — the state a startup snapshot of
				// the grant would never see. The dead WHOOP port keeps the case
				// honest: the newly granted read now fails reaching WHOOP, which is
				// exactly the proof it was allowed to try.
				await seedStore(store, SNAPSHOT_SCOPES);
				const after = await refusedRead(client, TODAY_URI);

				return { before, after };
			},
		);

		expect(refusals.before.message).toContain("read:sleep");
		// No longer the grant's refusal: the re-read store allows the read, and
		// what fails now is WHOOP being unreachable — a different failure with a
		// different message, reached without restarting the connection.
		expect(refusals.after.message).not.toContain("read:sleep");
		expect(refusals.after.message).toContain("WHOOP could not be reached");
	});
});

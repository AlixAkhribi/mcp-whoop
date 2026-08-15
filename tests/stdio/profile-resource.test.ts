import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** Where the profile is addressed — the resource this suite is about. */
const PROFILE_URI = "whoop://profile";

/** The resource that came before it, and that it is listed directly after. */
const TODAY_URI = "whoop://today";

/** The profile the stand-in WHOOP hands out, in WHOOP's own v2 shape. */
const PROFILE = {
	user_id: 10_129,
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
};

/** A stand-in WHOOP holding one user's basic profile. */
async function startFakeWhoop(): Promise<string> {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? "/", "http://whoop.invalid");
		request.resume();
		request.on("end", () => {
			const known = pathname === "/developer/v2/user/profile/basic";
			response.writeHead(known ? 200 : 404, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify(known ? PROFILE : {}));
		});
	});

	return listenOnLoopback(server);
}

/** The `text` of one content item, insisted on rather than assumed. */
function textOf(item: unknown): string {
	const text = (item as { text?: unknown } | undefined)?.text;
	expect(typeof text).toBe("string");

	return text as string;
}

describe("the profile as a resource, over real stdio", () => {
	it("answers a read with the very text its tool answers with", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { called, read } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			async (client) => ({
				called: await client.callTool({ name: "get_profile", arguments: {} }),
				read: await client.readResource({ uri: PROFILE_URI }),
			}),
		);

		// One item, not a bundle: the resource is one person's profile.
		expect(read.contents).toHaveLength(1);
		expect(read.contents[0]).toMatchObject({
			uri: PROFILE_URI,
			mimeType: "application/json",
		});
		// Byte-identical, not merely equivalent: the two surfaces answer the one
		// canonical rendering of the profile, so neither can drift from the other.
		expect(textOf(read.contents[0])).toBe(
			textOf((called.content as unknown[])[0]),
		);
	});

	it("lists whoop://profile straight after whoop://today, self-described", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { resources } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.listResources(),
		);

		// The place this one holds in the order a user's picker shows them:
		// directly after today's snapshot, never ahead of it and never with
		// anything wedged between the two. What the whole curated set is, entry
		// for entry, is the last-listed resource's case to make.
		const uris = resources.map((resource) => resource.uri);
		expect(uris).toContain(TODAY_URI);
		expect(uris.indexOf(PROFILE_URI)).toBe(uris.indexOf(TODAY_URI) + 1);

		const listed = resources.find((resource) => resource.uri === PROFILE_URI);
		expect(listed).toBeDefined();
		expect(listed).toMatchObject({
			uri: PROFILE_URI,
			name: "whoop_profile",
			title: "WHOOP profile",
			mimeType: "application/json",
			// Both audiences and nothing else: a person picks it out of a list, and
			// the model it is handed to has to know whose profile it is holding.
			annotations: { audience: ["user", "assistant"] },
		});
		// Exactly those two, in that order — `toMatchObject` would be satisfied by
		// a third audience nobody meant to address.
		expect(listed?.annotations?.audience).toEqual(["user", "assistant"]);
		// Self-describing: whose profile this is, in the words someone would use to
		// ask for it, rather than the endpoint it is read from.
		expect(listed?.description).toMatch(/logged in/i);
	});

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: PROFILE_URI }),
		);

		// Zero — immediately stale — though a name and an email address barely
		// change: the answer is bound to whoever the stored login belongs to, a
		// re-login can swap that account under an unchanged URI, and this server
		// has no way to call a cached copy back. Private: it identifies one
		// person.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	});
});

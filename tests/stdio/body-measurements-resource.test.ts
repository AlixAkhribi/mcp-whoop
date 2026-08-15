import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** Where the body measurements are addressed — the resource this suite is about. */
const BODY_MEASUREMENTS_URI = "whoop://body-measurements";

/** The resource that came before it, and that it is listed directly after. */
const PROFILE_URI = "whoop://profile";

/** The first of the curated set, ahead of both. */
const _TODAY_URI = "whoop://today";

/** The two listed after it — what a grant losing one scope must leave standing. */
const _RECOVERY_LAST_WEEK_URI = "whoop://recovery/last-week";
const _SLEEP_LAST_WEEK_URI = "whoop://sleep/last-week";

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
		await seedStore(store);

		const { called, read } = await withBuiltStdioClient(
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
	});

	it("lists whoop://body-measurements straight after whoop://profile, self-described", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { resources } = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.listResources(),
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
	});

	it("carries a zero-lifetime private cache hint on the resources/read result", async () => {
		const whoopBaseUrl = await startFakeWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const result = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => client.readResource({ uri: BODY_MEASUREMENTS_URI }),
		);

		// Zero — immediately stale — though a height and a weight barely change:
		// the answer is bound to whoever the stored login belongs to, a re-login
		// can swap that account under an unchanged URI, and this server has no
		// way to call a cached copy back. Private: it describes one person's
		// body.
		expect(result.ttlMs).toBe(0);
		expect(result.cacheScope).toBe("private");
	});
});

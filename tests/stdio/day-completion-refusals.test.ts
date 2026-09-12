import { createServer } from "node:http";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { writeStoredTokens } from "@/whoop/auth/tokens/store";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The family whose `{date}` these cases try to complete. */
const DAY_URI_TEMPLATE = "whoop://day/{date}";

/** The variable in it — the one thing a person fills in. */
const DATE_VARIABLE = "date";

/**
 * Where a case's WHOOP would be, if a case needed one: nothing listens there.
 * A refusal decided from the store alone must be decided before WHOOP is asked
 * anything, and pointing the server at a dead port is what proves it — anything
 * reaching upstream first would fail with WHOOP's unreachability instead.
 */
const NO_WHOOP_BASE_URL = "http://127.0.0.1:1";

/**
 * The bearer token a case plants and then hunts for: distinctive enough that
 * finding it anywhere in the refusal means the real value leaked rather than a
 * coincidental match.
 */
const ACCESS_TOKEN = "access-token-4e1c9b7f2d80";

/** Seeds a live login carrying the marked token above, granted every scope. */
async function seedMarkedLogin(store: string): Promise<void> {
	await writeStoredTokens(
		{
			accessToken: ACCESS_TOKEN,
			refreshToken: "a-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			scopes: ["read:cycles", "read:recovery", "read:sleep", "offline"],
		},
		{ env: { WHOOP_TOKEN_STORE: store } },
	);
}

/**
 * A stand-in WHOOP refusing every request with 403 and the bearer token that
 * made it quoted back in the body — the way WHOOP's own error bodies can echo
 * what they were sent.
 */
async function startTokenEchoingWhoop(): Promise<string> {
	const server = createServer((request, response) => {
		const bearer = request.headers.authorization?.replace(/^Bearer /, "");
		request.resume();
		request.on("end", () => {
			response.writeHead(403, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(
				JSON.stringify({
					error: "forbidden",
					message: `token ${bearer} may not list cycles`,
				}),
			);
		});
	});

	return listenOnLoopback(server);
}

/**
 * A stand-in WHOOP holding nothing: every collection answers one empty page.
 * Enough for a completion to succeed — a user WHOOP holds no cycles for is
 * offered no days, honestly — without a WHOOP failure in the way.
 */
async function startEmptyWhoop(): Promise<string> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.end(JSON.stringify({ records: [], next_token: null }));
		});
	});

	return listenOnLoopback(server);
}

/** Asks for `{date}` completions with `value` typed so far. */
async function completedDates(
	client: Client,
	value = "",
): Promise<{ values: string[]; total?: number; hasMore?: boolean }> {
	const result = await client.complete({
		ref: { type: "ref/resource", uri: DAY_URI_TEMPLATE },
		argument: { name: DATE_VARIABLE, value },
	});

	return result.completion;
}

/** The JSON-RPC error a refused completion comes back as. */
type Refusal = { code: number; message: string };

/**
 * Completes `{date}` when the case means it to be refused, and reduces the
 * rejection to the JSON-RPC error the client was answered with. A completion
 * that is answered — with days, or with silence — is itself the failure: a
 * completion that cannot be answered is never silently empty.
 */
async function refusedCompletion(client: Client): Promise<Refusal> {
	try {
		await completedDates(client);
	} catch (error) {
		const refusal = error as Refusal;
		expect(typeof refusal.code).toBe("number");

		return refusal;
	}

	throw new Error(
		`completing ${DAY_URI_TEMPLATE} was answered rather than refused`,
	);
}

describe("a refused date completion saying why, over real stdio", () => {
	it("refuses a completion by naming the login command when nothing is logged in", async () => {
		// An empty store: no login, and so no days this server could speak for.
		const store = await temporaryStore();

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => refusedCompletion(client),
		);

		// A completion cannot make the login offer — the revision allows an
		// unfinished answer on tool calls, resource reads and prompts only — so
		// refusing aloud is the whole of what it can do: the internal error every
		// surface fails with when nothing is logged in, naming the one command
		// that fixes it. The read that follows makes the offer.
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("npx mcp-whoop login");
	});

	it("refuses before asking WHOOP by naming every scope a narrowed grant lacks", async () => {
		const store = await temporaryStore();
		// A grant holding only the cycles: a day is assembled from three scopes,
		// so a suggestion offered under this login would lead every reader to a
		// read that refuses.
		await seedStore(store, ["read:cycles"]);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl: NO_WHOOP_BASE_URL },
			(client) => refusedCompletion(client),
		);

		// The whole of what the login is missing, not merely the first found
		// wanting, and the one command that grants it — decided from the store
		// alone: the dead WHOOP port proves nothing was asked upstream, since
		// anything reaching for WHOOP first would fail with its unreachability
		// instead.
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("read:recovery");
		expect(refusal.message).toContain("read:sleep");
		expect(refusal.message).toContain("npx mcp-whoop login");
	});

	it("relays a WHOOP failure scrubbed, never the token WHOOP echoed back", async () => {
		const whoopBaseUrl = await startTokenEchoingWhoop();
		const store = await temporaryStore();
		await seedMarkedLogin(store);

		const refusal = await withBuiltStdioClient(
			{ store, whoopBaseUrl },
			(client) => refusedCompletion(client),
		);

		// WHOOP failing is relayed as the internal error it is, with WHOOP's own
		// words quoted — scrubbed: the bearer token WHOOP echoed back crossed the
		// wire once already, and no refusal may carry it out a second time.
		expect(refusal.code).toBe(-32603);
		expect(refusal.message).toContain("[redacted]");
		expect(refusal.message).not.toContain(ACCESS_TOKEN);
	});

	it("narrates a completion on stderr like a read: answered with a duration, failed with the refusal", async () => {
		// A WHOOP holding no cycles at all: the completion is answerable — zero
		// days, honestly empty — which is what lets one connection hold a success
		// and a failure to narrate side by side.
		const whoopBaseUrl = await startEmptyWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		const { refusal, stderr } = await withBuiltStdioClient(
			{ store, whoopBaseUrl, stderr: "pipe" },
			async (client, _transport, stderr) => {
				const completion = await completedDates(client);
				// Answered, not refused: nothing to offer is still an answer.
				expect(completion.values).toEqual([]);
				// The login narrowed mid-connection — the grant is re-read per ask,
				// so the same connection's next completion is refused aloud.
				await seedStore(store, ["read:cycles"]);

				return { refusal: await refusedCompletion(client), stderr };
			},
		);

		// The completer has no request context of its own, so its narration wraps
		// the completer itself, named by the template: the first completion
		// answered with a duration, like a read.
		await vi.waitFor(() => {
			expect(stderr()).toMatch(/whoop:\/\/day\/\{date\} answered in \d+ms/);
		});
		// And the second failed aloud: an error line naming the template and
		// carrying the very message the client was refused with — scrubbed once,
		// logged and refused as the same string.
		const failedLine = await vi.waitFor(() => {
			const line = stderr()
				.split("\n")
				.find((written) => written.includes("[error]"));
			expect(line).toBeDefined();

			return line as string;
		});
		const narrated = failedLine.match(
			/whoop:\/\/day\/\{date\} failed after \d+ms: (?<message>.+)$/,
		);
		expect(narrated).not.toBeNull();
		expect(refusal.message).toContain(narrated?.groups?.message);
	});
});

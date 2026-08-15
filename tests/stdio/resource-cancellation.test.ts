import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

/** The resource under cancellation — its read starts with the cycle listing. */
const TODAY_URI = "whoop://today";

/**
 * Far below the 30-second bound every WHOOP request carries by default: an
 * upstream connection that closes inside this window closed because the
 * cancellation reached it, not because the request ran out its timeout.
 */
const PROPAGATION_WINDOW_MS = 8_000;

/** What the hanging WHOOP saw: that a request arrived, and that it died. */
type HeldRequest = {
	/** Resolves when the read's first upstream request reaches WHOOP. */
	readonly arrived: Promise<void>;
	/** True once that request's connection closed without being answered. */
	readonly closed: () => boolean;
};

/**
 * A stand-in WHOOP that answers nothing: it holds every request open and
 * reports when the first one arrives and when its connection dies. An
 * unanswered request's connection only closes early because the caller
 * abandoned it — which is exactly what these cases exist to observe.
 */
async function startHangingWhoop(): Promise<{
	baseUrl: string;
	held: HeldRequest;
}> {
	let sawRequest: () => void;
	const arrived = new Promise<void>((resolve) => {
		sawRequest = resolve;
	});
	let closed = false;

	const server = createServer((request, response) => {
		request.resume();
		response.on("close", () => {
			closed = true;
		});
		sawRequest();
		// And then: nothing. The response is never written.
	});

	return {
		baseUrl: await listenOnLoopback(server),
		held: { arrived, closed: () => closed },
	};
}

describe("cancelling a resource read, over real stdio", () => {
	it("aborts the in-flight WHOOP request instead of running out its timeout", async () => {
		const { baseUrl, held } = await startHangingWhoop();
		const store = await temporaryStore();
		await seedStore(store);

		await withBuiltStdioClient(
			{ store, whoopBaseUrl: baseUrl },
			async (client) => {
				// Occupies request id 0 before the read under test: the SDK's server
				// drops a `notifications/cancelled` whose requestId is 0 (a truthiness
				// check upstream), and a pinned connection sends no discovery probe,
				// so without this the read would land on the one id that cannot be
				// cancelled. Any real exchange has listed long before it reads.
				await client.listResources();

				const controller = new AbortController();
				const read = client.readResource(
					{ uri: TODAY_URI },
					{ signal: controller.signal },
				);
				// Swallowed here and asserted below: an abort rejection landing
				// between now and the await would otherwise be an unhandled one.
				read.catch(() => {});

				// Only once the read is provably inside its WHOOP request is there
				// anything to cancel: aborting earlier would test the client's own
				// bookkeeping rather than the server's.
				await held.arrived;
				expect(held.closed()).toBe(false);
				controller.abort();

				// The client's half: the pinned 2026-07-28 stdio contract turns the
				// abort into `notifications/cancelled` for the server and rejects the
				// caller's promise.
				await expect(read).rejects.toThrow();

				// The server's half, and the point of the case: the stdio rules say a
				// server should stop work on a cancelled request as soon as practical,
				// so the held request's connection has to die well inside the window —
				// long before the 30-second bound that would have ended it anyway.
				await vi.waitFor(
					() => {
						expect(held.closed()).toBe(true);
					},
					{ timeout: PROPAGATION_WINDOW_MS, interval: 50 },
				);
			},
		);
	});
});

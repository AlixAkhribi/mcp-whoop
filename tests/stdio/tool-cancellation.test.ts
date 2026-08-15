import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
	listenOnLoopback,
	seedStore,
	temporaryStore,
	withBuiltStdioClient,
} from "../helpers/harness";

const PROPAGATION_WINDOW_MS = 8_000;

async function startHangingWhoop(): Promise<{
	baseUrl: string;
	arrived: Promise<void>;
	closed: () => boolean;
}> {
	let sawRequest: () => void = () => {};
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
	});

	return {
		baseUrl: await listenOnLoopback(server),
		arrived,
		closed: () => closed,
	};
}

async function expectCancellationReachesWhoop(tool: string): Promise<void> {
	const whoop = await startHangingWhoop();
	const store = await temporaryStore();
	await seedStore(store, ["read:profile", "read:cycles", "read:recovery"]);
	await withBuiltStdioClient(
		{ store, whoopBaseUrl: whoop.baseUrl },
		async (client) => {
			await client.listTools();
			const controller = new AbortController();
			const call = client.callTool(
				{ name: tool, arguments: tool.startsWith("list_") ? { limit: 1 } : {} },
				{ signal: controller.signal },
			);
			call.catch(() => {});
			await whoop.arrived;
			controller.abort();
			await expect(call).rejects.toThrow();
			await vi.waitFor(() => expect(whoop.closed()).toBe(true), {
				timeout: PROPAGATION_WINDOW_MS,
				interval: 50,
			});
		},
	);
}

describe("cancelling tool calls over real stdio", () => {
	it("aborts a direct WHOOP read", async () => {
		await expectCancellationReachesWhoop("get_profile");
	});

	it("aborts a list read used by a summary-style path", async () => {
		await expectCancellationReachesWhoop("list_cycles");
	});
});

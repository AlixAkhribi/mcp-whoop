import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OperationCancelledError } from "@/lib/cancellation";
import { registerSecrets } from "@/lib/redaction";
import { readWhoopJson, readWhoopJsonOrAbsent } from "@/whoop/api/client/read";

import { listenOnLoopback } from "../helpers/harness";

const schema = z.object({ value: z.string() });

type ScriptedAnswer = {
	readonly status: number;
	readonly body: string;
	readonly headers?: Record<string, string>;
};

async function endpointFor(answer: ScriptedAnswer): Promise<URL> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(answer.status, {
				"content-type": "application/json",
				connection: "close",
				...answer.headers,
			});
			response.end(answer.body);
		});
	});

	return new URL(`${await listenOnLoopback(server)}/value`);
}

function read(endpoint: URL, signal?: AbortSignal) {
	return readWhoopJson({
		operation: "the test read",
		endpoint,
		accessToken: "reader-access-token",
		schema,
		signal,
	});
}

describe("the shared WHOOP JSON reader", () => {
	it("returns schema-validated JSON", async () => {
		await expect(
			read(await endpointFor({ status: 200, body: '{"value":"ok"}' })),
		).resolves.toEqual({ value: "ok" });
	});

	it.each(["not json", '{"value":42}'])(
		"rejects an unexpected success body: %s",
		async (body) => {
			await expect(
				read(await endpointFor({ status: 200, body })),
			).rejects.toThrow("unexpected body");
		},
	);

	it("turns a 401 into the authorization control-flow error", async () => {
		await expect(
			read(await endpointFor({ status: 401, body: "{}" })),
		).rejects.toMatchObject({ name: "WhoopUnauthorizedError" });
	});

	it("treats an ordinary 404 as a rejection", async () => {
		await expect(
			read(await endpointFor({ status: 404, body: '{"message":"missing"}' })),
		).rejects.toThrow(/HTTP 404.*missing/);
	});

	it("can treat a 404 as absence", async () => {
		const endpoint = await endpointFor({ status: 404, body: "{}" });

		await expect(
			readWhoopJsonOrAbsent({
				operation: "the optional test read",
				endpoint,
				accessToken: "reader-access-token",
				schema,
			}),
		).resolves.toBeNull();
	});

	it.each([
		{
			status: 429,
			headers: { "retry-after": "12" },
			message: /rate-limited.*12 seconds/i,
		},
		{
			status: 503,
			headers: {} as Record<string, string>,
			message: /temporarily unavailable.*retry/i,
		},
	])(
		"classifies retryable HTTP $status",
		async ({ status, headers, message }) => {
			await expect(
				read(await endpointFor({ status, headers, body: "{}" })),
			).rejects.toThrow(message);
		},
	);

	it("redacts a non-retryable upstream message", async () => {
		const secret = "reader-upstream-secret";
		registerSecrets(secret);

		await expect(
			read(
				await endpointFor({
					status: 400,
					body: JSON.stringify({ message: `invalid ${secret}` }),
				}),
			),
		).rejects.toThrow("invalid [redacted]");
	});

	it("preserves cancellation before headers", async () => {
		const server = createServer((request) => request.resume());
		const endpoint = new URL(`${await listenOnLoopback(server)}/value`);
		const controller = new AbortController();
		const pending = read(endpoint, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
	});

	it("preserves cancellation while the response body is pending", async () => {
		let headersSent: () => void = () => {};
		const sent = new Promise<void>((resolve) => {
			headersSent = resolve;
		});
		const server = createServer((request, response) => {
			request.resume();
			response.writeHead(200, {
				"content-type": "application/json",
				connection: "close",
			});
			response.flushHeaders();
			headersSent();
		});
		const endpoint = new URL(`${await listenOnLoopback(server)}/value`);
		const controller = new AbortController();
		const pending = read(endpoint, controller.signal);
		await sent;
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
	});
});

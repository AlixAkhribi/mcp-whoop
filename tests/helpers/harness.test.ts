import { describe, expect, it } from "vitest";

import { deferCleanup, runDeferredCleanups } from "./harness";

describe("deferred test cleanup", () => {
	it("runs every cleanup in reverse registration order", async () => {
		const order: number[] = [];
		deferCleanup(() => {
			order.push(1);
		});
		deferCleanup(async () => {
			order.push(2);
		});

		await runDeferredCleanups();

		expect(order).toEqual([2, 1]);
	});

	it("aggregates failures after draining the registry", async () => {
		const completed: string[] = [];
		deferCleanup(() => {
			completed.push("first");
			throw new Error("first failed");
		});
		deferCleanup(() => {
			completed.push("second");
			throw new Error("second failed");
		});

		const failure = await runDeferredCleanups().catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toHaveLength(2);
		expect(completed).toEqual(["second", "first"]);
		await expect(runDeferredCleanups()).resolves.toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";

import { createWakeDatesMemo } from "@/whoop/reads/recent-days-memo";

/**
 * How long one listing keeps answering completions, restated rather than
 * imported so a change to the lifetime has to be made twice — once in the
 * memo, once in what a conversation is promised: about a minute of typing.
 */
const MEMO_LIFETIME_MS = 60_000;

/** The token every serve here runs under — the key that never changes. */
const ACCESS_TOKEN = "an-access-token";

/** The days the stand-in listing answers with, newest first. */
const LISTED_DAYS = ["2026-07-28", "2026-07-27"];

/** A listing this test decides when to settle. */
function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((fulfil, refuse) => {
		resolve = fulfil;
		reject = refuse;
	});

	return { promise, resolve, reject };
}

describe("how long a wake-days memo keeps answering", () => {
	it("asks WHOOP again once the memo has outlived its minute", async () => {
		// An injected clock, because the lifetime is the thing under test: the
		// wall clock cannot be waited out inside a unit, and must not be read.
		let instant = 0;
		const listedAt: number[] = [];
		const memo = createWakeDatesMemo({ now: () => instant });
		const list = async () => {
			listedAt.push(instant);

			return [...LISTED_DAYS];
		};

		const established = await memo.serve(ACCESS_TOKEN, list);
		// One tick short of the lifetime: still the same conversation's typing.
		instant += MEMO_LIFETIME_MS - 1;
		const withinLifetime = await memo.serve(ACCESS_TOKEN, list);
		// Two more ticks: the memo is now older than its lifetime, measured from
		// the listing that established it — not from the serve that last read it.
		instant += 2;
		const afterLifetime = await memo.serve(ACCESS_TOKEN, list);

		// Every answer held the same days: expiring changes when WHOOP is asked,
		// never what a completion is told.
		expect(established).toEqual(LISTED_DAYS);
		expect(withinLifetime).toEqual(LISTED_DAYS);
		expect(afterLifetime).toEqual(LISTED_DAYS);
		// And the listing ran exactly when the memo could not answer: once at the
		// start, and once the moment the minute had passed.
		expect(listedAt).toEqual([0, MEMO_LIFETIME_MS + 1]);
	});
});

describe("concurrent wake-days memo misses", () => {
	it("shares one listing between two serves under the same access token", async () => {
		const listing = deferred<string[]>();
		let listings = 0;
		const list = (): Promise<string[]> => {
			listings += 1;

			return listing.promise;
		};
		const memo = createWakeDatesMemo();

		const first = memo.serve(ACCESS_TOKEN, list);
		const second = memo.serve(ACCESS_TOKEN, list);
		expect(listings).toBe(1);

		listing.resolve([...LISTED_DAYS]);
		const [firstDates, secondDates] = await Promise.all([first, second]);
		expect(firstDates).toEqual(LISTED_DAYS);
		expect(secondDates).toEqual(LISTED_DAYS);
		// Joining shares the work, not the mutable answer handed to another caller.
		expect(secondDates).not.toBe(firstDates);
	});

	it("rejects every joiner and lists again after the shared listing refuses", async () => {
		const listing = deferred<string[]>();
		const refusal = new Error("WHOOP refused the listing");
		let listings = 0;
		const list = (): Promise<string[]> => {
			listings += 1;

			return listings === 1
				? listing.promise
				: Promise.resolve([...LISTED_DAYS]);
		};
		const memo = createWakeDatesMemo();

		const first = memo.serve(ACCESS_TOKEN, list);
		const second = memo.serve(ACCESS_TOKEN, list);
		const joined = Promise.allSettled([first, second]);
		expect(listings).toBe(1);

		listing.reject(refusal);
		expect(await joined).toEqual([
			{ status: "rejected", reason: refusal },
			{ status: "rejected", reason: refusal },
		]);

		// A refusal established no answer: the next serve has to ask again.
		await expect(memo.serve(ACCESS_TOKEN, list)).resolves.toEqual(LISTED_DAYS);
		expect(listings).toBe(2);
	});

	it("starts a separate listing for a concurrent serve under a different access token", async () => {
		const firstListing = deferred<string[]>();
		const secondListing = deferred<string[]>();
		let firstListings = 0;
		let secondListings = 0;
		const memo = createWakeDatesMemo();

		const first = memo.serve("the-first-token", () => {
			firstListings += 1;

			return firstListing.promise;
		});
		const second = memo.serve("the-second-token", () => {
			secondListings += 1;

			return secondListing.promise;
		});

		expect(firstListings).toBe(1);
		expect(secondListings).toBe(1);
		firstListing.resolve([LISTED_DAYS[0]]);
		secondListing.resolve([LISTED_DAYS[1]]);
		await expect(first).resolves.toEqual([LISTED_DAYS[0]]);
		await expect(second).resolves.toEqual([LISTED_DAYS[1]]);
	});
});

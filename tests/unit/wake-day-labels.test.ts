import { describe, expect, it } from "vitest";

import type { WhoopCycle } from "@/whoop/api/data/cycles";
import type { WhoopSleep } from "@/whoop/api/data/sleeps";
import {
	findCycleByWakeDate,
	NoSuchDayError,
	parseWakeDate,
} from "@/whoop/reads/day";
import { wakeDatesOfCycles } from "@/whoop/reads/recent-days";
import { buildRecoverySummary } from "@/whoop/reads/recovery-summary-model";
import { buildSleepSummary } from "@/whoop/reads/sleep-summary-model";
import { buildCycle, buildSleep } from "../fixtures/whoop-records";

/** The instant a local wall-clock time falls on, at the offset it was lived at. */
function at(local: string): string {
	return new Date(local).toISOString();
}

describe("the sleep digest's wake-day labels", () => {
	it("labels a night by the morning it ends, at the night's own offset", () => {
		const night = buildSleep({ day: "2026-07-28", timezoneOffset: "-05:00" });

		const summary = buildSleepSummary([night], 1);

		// The night is the one WHOOP would hold: asleep at 22:00 on the 27th,
		// awake at 06:00 on the 28th, both read at the offset it carries.
		expect(night.start).toBe(at("2026-07-27T22:00:00.000-05:00"));
		expect(night.end).toBe(at("2026-07-28T06:00:00.000-05:00"));
		// It began on the 27th and is named by the morning it ended on — never by
		// the evening it started.
		expect(summary.per_day[0]?.day).toBe("2026-07-28");
	});

	it("reads that end at the record's offset, never at UTC", () => {
		// A late night east of Greenwich: awake at 01:00 on the 28th at +09:00,
		// which is still 16:00 on the 27th in UTC.
		const night = buildSleep({
			day: "2026-07-28",
			timezoneOffset: "+09:00",
			wakeAt: "01:00:00",
		});

		const summary = buildSleepSummary([night], 1);

		expect(night.end).toBe(at("2026-07-28T01:00:00.000+09:00"));
		// The Given: WHOOP stamps the instant in UTC, where it is the day before.
		expect(night.end.startsWith("2026-07-27")).toBe(true);
		// The date the user woke on is the date they were living in.
		expect(summary.per_day[0]?.day).toBe("2026-07-28");
	});

	it("counts only the naps ending on or after the oldest night's wake day", () => {
		const nap = {
			wakeAt: "14:00:00",
			nap: true,
			inBedMilli: 3_600_000,
		} as const;
		// Two nights, so the window the digest speaks for opens on the wake day
		// of the older one: the 22nd.
		const newerNight = buildSleep({
			id: "night-2026-07-23",
			day: "2026-07-23",
		});
		const oldestNight = buildSleep({
			id: "night-2026-07-22",
			day: "2026-07-22",
		});
		const napInsideTheWindow = buildSleep({
			id: "nap-2026-07-22",
			day: "2026-07-22",
			...nap,
		});
		// An afternoon nap on the 21st: the evening the oldest night began, but a
		// wake day the digest does not speak for.
		const napBeforeTheWindow = buildSleep({
			id: "nap-2026-07-21",
			day: "2026-07-21",
			...nap,
		});

		// Newest first, the way WHOOP lists them.
		const summary = buildSleepSummary(
			[newerNight, napInsideTheWindow, oldestNight, napBeforeTheWindow],
			2,
		);

		expect(summary.per_day.map((row) => row.day)).toEqual([
			"2026-07-23",
			"2026-07-22",
		]);
		expect(summary.nap_count).toBe(1);
	});
});

describe("the recovery digest's wake-day labels", () => {
	it("labels a cycle by the end of its opening sleep", () => {
		const cycle = buildCycle({ day: "2026-07-28" });
		const openingSleep = buildSleep({ cycleId: cycle.id, day: "2026-07-28" });

		const summary = buildRecoverySummary([cycle], [], [openingSleep], 1);

		// WHOOP's own boundary: the cycle opened at 22:00 on the 27th, where the
		// sleep carrying its id began, and the user woke into it at 06:00 the
		// morning after.
		expect(cycle.start).toBe(at("2026-07-27T22:00:00.000Z"));
		expect(openingSleep.end).toBe(at("2026-07-28T06:00:00.000Z"));
		// That morning names the day, never the evening the cycle began.
		expect(summary.per_day[0]?.day).toBe("2026-07-28");
	});

	it("falls back to the start of a cycle WHOOP recorded no sleep for", () => {
		const cycle = buildCycle({ day: "2026-07-28" });
		// A night carrying the neighbouring cycle's id: WHOOP holds no sleep that
		// opens this one, so it has no wake to be named by.
		const otherNight = buildSleep({ cycleId: cycle.id + 1, day: "2026-07-28" });

		const summary = buildRecoverySummary([cycle], [], [otherNight], 1);

		// The nearest fact WHOOP holds: the date the cycle's own start falls on,
		// read at the offset it carries — the evening of the 27th here.
		expect(summary.per_day[0]?.day).toBe("2026-07-27");
	});
});

/** Two hours in bed: the second, short night of a day WHOOP filed twice. */
const SHORT_NIGHT_MILLI = 7_200_000;

/**
 * The rare short day, as WHOOP files one: the user woke at 06:00 on the 4th,
 * went back to bed at 08:00 and woke again at 10:00, so WHOOP bounded a second
 * cycle at that second onset. Two cycles whose opening sleeps both end on the
 * 4th — each starting where the sleep carrying its id starts, WHOOP's own
 * boundary, and the earlier ending where the later begins.
 */
function shortDayOfTheFourth(): {
	earlier: WhoopCycle;
	later: WhoopCycle;
	sleeps: WhoopSleep[];
} {
	const night = buildSleep({
		id: "sleep-2026-08-04-night",
		cycleId: 93_844,
		day: "2026-08-04",
	});
	const morning = buildSleep({
		id: "sleep-2026-08-04-morning",
		cycleId: 93_845,
		day: "2026-08-04",
		wakeAt: "10:00:00",
		inBedMilli: SHORT_NIGHT_MILLI,
	});

	return {
		earlier: {
			...buildCycle({ id: 93_844, day: "2026-08-04" }),
			end: morning.start,
		},
		later: {
			...buildCycle({ id: 93_845, day: "2026-08-04" }),
			start: morning.start,
		},
		sleeps: [night, morning],
	};
}

describe("the cycle a date names", () => {
	it("chooses the cycle whose opening sleep ended that morning", () => {
		// Three consecutive days as WHOOP holds them, newest first: each cycle
		// bounded at sleep onset the evening before, and the night carrying its
		// id ending the morning that names it.
		const days = ["2026-08-05", "2026-08-04", "2026-08-03"];
		const cycles = days.map((day, index) =>
			buildCycle({ id: 93_845 - index, day }),
		);
		const sleeps = days.map((day, index) =>
			buildSleep({ id: `sleep-${day}`, cycleId: 93_845 - index, day }),
		);

		const chosen = findCycleByWakeDate(cycles, sleeps, "2026-08-04");

		// The cycle the 4th names, and the night that opened it.
		expect(chosen?.cycle.id).toBe(93_844);
		expect(chosen?.openingSleep?.id).toBe("sleep-2026-08-04");
		// Whatever date its own start falls on: WHOOP bounds the cycle at onset,
		// so it began on the 3rd — a boundary, never the label.
		expect(chosen?.cycle.start.startsWith("2026-08-03")).toBe(true);
		expect(chosen?.openingSleep?.end.startsWith("2026-08-04")).toBe(true);
	});

	it("resolves two cycles woken into on one date to the later one", () => {
		const { earlier, later, sleeps } = shortDayOfTheFourth();

		// The Given, stated rather than assumed: two cycles the 4th names,
		// because the sleep opening each of them ended that morning — and one of
		// them began after the other.
		expect(sleeps.every((sleep) => sleep.end.startsWith("2026-08-04"))).toBe(
			true,
		);
		expect(Date.parse(later.start)).toBeGreaterThan(Date.parse(earlier.start));

		// Newest first, the way WHOOP lists them — and oldest first, the way it
		// might. Which end of the listing a cycle arrives at is not the rule.
		for (const listing of [
			[later, earlier],
			[earlier, later],
		]) {
			const chosen = findCycleByWakeDate(listing, sleeps, "2026-08-04");

			// The day as WHOOP last filed it: the cycle that started later, with
			// the sleep that opened it. The earlier one is not what the date
			// names, wherever in the listing it came.
			expect(chosen?.cycle.id).toBe(later.id);
			expect(chosen?.openingSleep?.id).toBe("sleep-2026-08-04-morning");
		}
	});

	it("counts only the cycles woken into on that date among the candidates", () => {
		// Two ordinary consecutive days: one cycle woken into on the 4th, the
		// next woken into on the 5th — and the 5th's is the later-started of the
		// two, so a rule reaching for the latest start before it has read the
		// dates would answer the 4th with tomorrow.
		const fourth = buildCycle({ id: 93_844, day: "2026-08-04" });
		const fifth = buildCycle({ id: 93_845, day: "2026-08-05" });
		const sleeps = [
			buildSleep({
				id: "sleep-2026-08-05",
				cycleId: fifth.id,
				day: "2026-08-05",
			}),
			buildSleep({
				id: "sleep-2026-08-04",
				cycleId: fourth.id,
				day: "2026-08-04",
			}),
		];

		const chosen = findCycleByWakeDate([fifth, fourth], sleeps, "2026-08-04");

		// The Given, stated rather than assumed.
		expect(Date.parse(fifth.start)).toBeGreaterThan(Date.parse(fourth.start));
		// Only a cycle the date names is a candidate at all: the one whose
		// opening sleep ended that morning. The later start settles a tie between
		// candidates; it never makes one.
		expect(chosen?.cycle.id).toBe(fourth.id);
		expect(chosen?.openingSleep?.id).toBe("sleep-2026-08-04");
	});
});

describe("the days a run of cycles is named by", () => {
	it("names a short day's two cycles as one date", () => {
		const { earlier, later, sleeps } = shortDayOfTheFourth();

		// Newest first, the way WHOOP lists them: the later cycle came first.
		const dates = wakeDatesOfCycles([later, earlier], sleeps);

		// Two cycles whose opening sleeps both ended on the 4th are one day, not
		// two: a listing of days that names a day twice is the lie, so the 4th
		// appears once — where its first cycle came.
		expect(dates).toEqual(["2026-08-04"]);
	});

	it("names a sleepless cycle and the day it fell back onto as one date", () => {
		// A cycle WHOOP recorded no sleep for: it would have been the 5th's, but
		// with no wake to be named by it falls back to the date its own start
		// falls on — the evening of the 4th. Listed ahead of the
		// cycle actually woken into on the 4th, the way WHOOP lists.
		const sleepless = buildCycle({ id: 93_845, day: "2026-08-05" });
		const fourth = buildCycle({ id: 93_844, day: "2026-08-04" });
		const fourthNight = buildSleep({
			id: "sleep-2026-08-04",
			cycleId: fourth.id,
			day: "2026-08-04",
		});

		const dates = wakeDatesOfCycles([sleepless, fourth], [fourthNight]);

		// The Given, stated rather than assumed: the fallback label is the 4th.
		expect(sleepless.start.startsWith("2026-08-04")).toBe(true);
		// One date however differently the two cycles came to carry it: the
		// fallback and the wake label collapse into the same day, once.
		expect(dates).toEqual(["2026-08-04"]);
	});
});

describe("the dates a day can be named by", () => {
	it("accepts a real YYYY-MM-DD calendar date and nothing else", () => {
		// Everything a person or a client might put in `{date}` that is not the
		// one form this server reads: a word, a month and day off the calendar,
		// a date that only exists in a non-leap year's imagination, an unpadded
		// form, and one with a query string dragged along behind it.
		for (const date of [
			"yesterday",
			"2026-13-45",
			"2026-02-30",
			"2026-8-4",
			"2026-08-04?x=1",
		]) {
			expect(() => parseWakeDate(date), `"${date}" was read as a date`).toThrow(
				NoSuchDayError,
			);
		}
		// And the two that are dates: an ordinary morning, and the leap day that
		// a round trip through `Date` has to keep rather than roll over.
		expect(parseWakeDate("2026-08-04")).toBe("2026-08-04");
		expect(parseWakeDate("2024-02-29")).toBe("2024-02-29");
	});
});

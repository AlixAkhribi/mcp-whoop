import { describe, expect, it } from "vitest";

import { buildRecoverySummary } from "@/whoop/reads/recovery-summary-model";
import { buildSleepSummary } from "@/whoop/reads/sleep-summary-model";
import {
	buildTodaySnapshot,
	todaySnapshotSchema,
} from "@/whoop/reads/today-snapshot";
import {
	buildRecovery,
	buildRecoveryWeek,
	buildSleepWeek,
	buildTodayRecords,
} from "../fixtures/whoop-records";

describe("pure application read models", () => {
	it("builds today's fixed join shape without auth or I/O", () => {
		const { cycle, recovery, sleep } = buildTodayRecords();

		const scored = buildTodaySnapshot(cycle, recovery, sleep);
		const absent = buildTodaySnapshot(cycle, null, null);

		expect(todaySnapshotSchema.parse(scored)).toEqual(scored);
		expect(scored).toMatchObject({
			recovery_state: "SCORED",
			recovery,
			sleep,
		});
		expect(absent).toMatchObject({
			recovery_state: "ABSENT",
			recovery: null,
			sleep: null,
		});
	});

	it("calculates a sleep week and excludes its nap from nightly spreads", () => {
		const summary = buildSleepSummary(buildSleepWeek(), 7);

		expect(summary).toMatchObject({
			days_requested: 7,
			days_with_records: 7,
			days_scored: 7,
			nap_count: 1,
			sleep_performance_percentage: { mean: 76, min: 70, max: 82 },
			time_in_bed_milli: {
				mean: 28_800_000,
				min: 27_000_000,
				max: 30_600_000,
			},
			sleep_efficiency_percentage: { mean: 88, min: 85, max: 91 },
			stage_totals: {
				light_milli: 84_000_000,
				sws_milli: 42_000_000,
				rem_milli: 63_000_000,
				awake_milli: 12_600_000,
			},
		});
		expect(summary.per_day.map(({ day }) => day)).toEqual([
			"2026-07-28",
			"2026-07-27",
			"2026-07-26",
			"2026-07-25",
			"2026-07-24",
			"2026-07-23",
			"2026-07-22",
		]);
	});

	it("joins recoveries to cycle days and calculates scored spreads", () => {
		const { cycles, recoveries } = buildRecoveryWeek();

		const summary = buildRecoverySummary(cycles, recoveries, 7);

		expect(summary).toMatchObject({
			days_requested: 7,
			days_with_records: 7,
			days_scored: 7,
			recovery_score: { mean: 58, min: 40, max: 76 },
			hrv_rmssd_milli: { mean: 40.5, min: 31.5, max: 49.5 },
			resting_heart_rate: { mean: 59, min: 50, max: 68 },
		});
		expect(summary.per_day[0]).toMatchObject({
			day: "2026-07-28",
			score_state: "SCORED",
			recovery_score: 76,
		});
	});

	it("reports pending and absent recovery joins without inventing scores", () => {
		const { cycles, recoveries } = buildRecoveryWeek();
		recoveries[0] = buildRecovery({ scoreState: "PENDING_SCORE" });
		recoveries.pop();

		const summary = buildRecoverySummary(cycles, recoveries, 7);

		expect(summary.days_with_records).toBe(6);
		expect(summary.days_scored).toBe(5);
		expect(summary.per_day[0]).toMatchObject({
			score_state: "PENDING_SCORE",
			recovery_score: null,
		});
		expect(summary.per_day.at(-1)).toMatchObject({
			score_state: "ABSENT",
			recovery_score: null,
		});
	});

	it("returns fresh fixture graphs for every test", () => {
		const first = buildSleepWeek();
		const second = buildSleepWeek();

		expect(first).not.toBe(second);
		expect(first[0]).not.toBe(second[0]);
		expect(first[0]?.score).not.toBe(second[0]?.score);
	});
});

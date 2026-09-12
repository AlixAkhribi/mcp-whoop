import type { WhoopCycle } from "@/whoop/api/data/cycles";
import type { WhoopRecovery } from "@/whoop/api/data/recoveries";
import type { WhoopSleep } from "@/whoop/api/data/sleeps";

const USER_ID = 10_129;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The local clock time a fixture night ends at — the wake that names its day. */
const WAKE_AT = "06:00:00";

/** How long a fixture night lasts, onset to wake: eight hours in bed. */
const IN_BED_MILLI = 28_800_000;

/**
 * One WHOOP cycle, bounded the way WHOOP bounds one: `day` is the
 * wake day that names it — the morning the user was woken into it — so the
 * cycle *starts* at sleep onset the evening before, where the sleep carrying
 * its id starts, and runs to the next night's onset a day later. The newest
 * cycle WHOOP holds is still running, which `open` says.
 */
export function buildCycle({
	id = 93_845,
	day = "2026-07-28",
	timezoneOffset = "+00:00",
	open = false,
}: {
	id?: number;
	day?: string;
	timezoneOffset?: string;
	open?: boolean;
} = {}): WhoopCycle {
	const start =
		Date.parse(`${day}T${WAKE_AT}.000${timezoneOffset}`) - IN_BED_MILLI;

	return {
		id,
		user_id: USER_ID,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(start + HOUR_MS).toISOString(),
		start: new Date(start).toISOString(),
		end: open ? null : new Date(start + DAY_MS).toISOString(),
		timezone_offset: timezoneOffset,
		score_state: "SCORED",
		score: {
			strain: 5.2951527,
			kilojoule: 8288.297,
			average_heart_rate: 68,
			max_heart_rate: 141,
		},
	};
}

export function buildRecovery({
	cycleId = 93_845,
	day = "2026-07-28",
	recoveryScore = 76,
	hrvMilli = 49.5,
	restingHeartRate = 68,
	scoreState = "SCORED",
}: {
	cycleId?: number;
	day?: string;
	recoveryScore?: number;
	hrvMilli?: number;
	restingHeartRate?: number;
	scoreState?: WhoopRecovery["score_state"];
} = {}): WhoopRecovery {
	const start = Date.parse(`${day}T06:00:00.000Z`);

	return {
		cycle_id: cycleId,
		sleep_id: `sleep-${day}`,
		user_id: USER_ID,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(start + HOUR_MS).toISOString(),
		score_state: scoreState,
		score:
			scoreState === "SCORED"
				? {
						user_calibrating: false,
						recovery_score: recoveryScore,
						resting_heart_rate: restingHeartRate,
						hrv_rmssd_milli: hrvMilli,
						spo2_percentage: 95.6875,
						skin_temp_celsius: 33.7,
					}
				: null,
	};
}

/**
 * One WHOOP sleep record, described the way WHOOP files one: `day`
 * is the wake day — the date the sleep *ended* on, read at the offset it
 * carries — and `wakeAt` is the local clock time it ended at. A night therefore
 * starts `inBedMilli` earlier, the evening before the morning that names it,
 * which is the record WHOOP actually holds.
 */
export function buildSleep({
	id = "sleep-2026-07-28",
	cycleId = 93_845,
	day = "2026-07-28",
	timezoneOffset = "+00:00",
	wakeAt = WAKE_AT,
	nap = false,
	inBedMilli = IN_BED_MILLI,
	performance = 76,
	efficiency = 88,
	scoreState = "SCORED",
}: {
	id?: string;
	cycleId?: number;
	day?: string;
	timezoneOffset?: string;
	wakeAt?: string;
	nap?: boolean;
	inBedMilli?: number;
	performance?: number;
	efficiency?: number;
	scoreState?: WhoopSleep["score_state"];
} = {}): WhoopSleep {
	const end = Date.parse(`${day}T${wakeAt}.000${timezoneOffset}`);
	const start = end - inBedMilli;
	const awakeMilli = 1_800_000;
	const lightMilli = 12_000_000;
	const swsMilli = 6_000_000;

	return {
		id,
		cycle_id: cycleId,
		v1_id: null,
		user_id: USER_ID,
		created_at: new Date(start).toISOString(),
		updated_at: new Date(end).toISOString(),
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
		timezone_offset: timezoneOffset,
		nap,
		score_state: scoreState,
		score:
			scoreState === "SCORED"
				? {
						stage_summary: {
							total_in_bed_time_milli: inBedMilli,
							total_awake_time_milli: awakeMilli,
							total_no_data_time_milli: 0,
							total_light_sleep_time_milli: lightMilli,
							total_slow_wave_sleep_time_milli: swsMilli,
							total_rem_sleep_time_milli:
								inBedMilli - awakeMilli - lightMilli - swsMilli,
							sleep_cycle_count: 5,
							disturbance_count: 8,
						},
						sleep_needed: {
							baseline_milli: 28_800_000,
							need_from_sleep_debt_milli: 0,
							need_from_recent_strain_milli: 0,
							need_from_recent_nap_milli: 0,
						},
						respiratory_rate: 15.4,
						sleep_performance_percentage: performance,
						sleep_consistency_percentage: 82,
						sleep_efficiency_percentage: efficiency,
					}
				: null,
	};
}

export function buildTodayRecords(): {
	cycle: WhoopCycle;
	recovery: WhoopRecovery;
	sleep: WhoopSleep;
} {
	return {
		cycle: buildCycle({ open: true }),
		recovery: buildRecovery(),
		sleep: buildSleep(),
	};
}

export function buildSleepWeek(): WhoopSleep[] {
	const days = [
		"2026-07-28",
		"2026-07-27",
		"2026-07-26",
		"2026-07-25",
		"2026-07-24",
		"2026-07-23",
		"2026-07-22",
	];
	const nights = days.map((day, index) =>
		buildSleep({
			id: `night-${day}`,
			cycleId: 93_845 - index,
			day,
			performance: 82 - index * 2,
			efficiency: 91 - index,
			inBedMilli: 30_600_000 - index * 600_000,
		}),
	);

	return [
		...nights,
		// An afternoon nap, ending on the wake day the third night is named by.
		buildSleep({
			id: "nap-2026-07-26",
			cycleId: 93_843,
			day: "2026-07-26",
			wakeAt: "14:00:00",
			nap: true,
			inBedMilli: 3_600_000,
		}),
	];
}

/**
 * A week of cycle-days as WHOOP holds one: the cycles, the recoveries scored
 * against them, and the nights that opened them — each night starting where
 * its cycle starts and ending the morning that names the day, so a digest
 * labeling a cycle by its opening sleep has the sleep to label it by.
 */
export function buildRecoveryWeek(): {
	cycles: WhoopCycle[];
	recoveries: WhoopRecovery[];
	sleeps: WhoopSleep[];
} {
	const days = [
		"2026-07-28",
		"2026-07-27",
		"2026-07-26",
		"2026-07-25",
		"2026-07-24",
		"2026-07-23",
		"2026-07-22",
	];

	return {
		cycles: days.map((day, index) =>
			buildCycle({ id: 93_845 - index, day, open: index === 0 }),
		),
		recoveries: days.map((day, index) =>
			buildRecovery({
				cycleId: 93_845 - index,
				day,
				recoveryScore: 76 - index * 6,
				hrvMilli: 49.5 - index * 3,
				restingHeartRate: 68 - index * 3,
			}),
		),
		sleeps: days.map((day, index) =>
			buildSleep({ id: `sleep-${day}`, cycleId: 93_845 - index, day }),
		),
	};
}

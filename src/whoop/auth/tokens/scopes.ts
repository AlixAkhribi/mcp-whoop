/** Literal OAuth scopes understood by this server. */
export const READ_SCOPES = {
	profile: "read:profile",
	bodyMeasurements: "read:body_measurement",
	cycles: "read:cycles",
	sleep: "read:sleep",
	recovery: "read:recovery",
	workout: "read:workout",
} as const;

/** Every data-read scope requested by a default login. */
export const DEFAULT_READ_SCOPES = Object.values(READ_SCOPES);

/** Makes WHOOP issue the rotating refresh token the server relies on. */
export const OFFLINE_SCOPE = "offline";

export const PROFILE_SCOPES = [READ_SCOPES.profile] as const;
export const BODY_MEASUREMENTS_SCOPES = [READ_SCOPES.bodyMeasurements] as const;
export const SLEEP_SUMMARY_SCOPES = [READ_SCOPES.sleep] as const;
export const RECOVERY_SUMMARY_SCOPES = [
	READ_SCOPES.cycles,
	READ_SCOPES.recovery,
] as const;
export const TODAY_SNAPSHOT_SCOPES = [
	READ_SCOPES.cycles,
	READ_SCOPES.recovery,
	READ_SCOPES.sleep,
] as const;

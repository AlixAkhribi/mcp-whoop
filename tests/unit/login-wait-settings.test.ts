import { describe, expect, it } from "vitest";

import {
	DEFAULT_LOGIN_TTL_MS,
	DEFAULT_LOGIN_WAIT_MS,
	loginAttemptLifetimeMs,
	loginWaitMs,
} from "@/config/elicited-login";
import { environmentProblems, environmentWarnings } from "@/config/environment";

/** Every command the gate can be asked about. */
const COMMANDS = ["stdio", "login", "logout"] as const;

describe("the elicited login's wait budget and attempt lifetime", () => {
	it("are configuration variables like every other, falling back to the documented defaults", () => {
		expect(DEFAULT_LOGIN_WAIT_MS).toBe(2_000);
		expect(DEFAULT_LOGIN_TTL_MS).toBe(600_000);
		expect(loginWaitMs({})).toBe(DEFAULT_LOGIN_WAIT_MS);
		expect(loginAttemptLifetimeMs({})).toBe(DEFAULT_LOGIN_TTL_MS);
		// Blank counts as unset.
		expect(loginWaitMs({ WHOOP_LOGIN_WAIT_MS: "  " })).toBe(
			DEFAULT_LOGIN_WAIT_MS,
		);
		expect(loginAttemptLifetimeMs({ WHOOP_LOGIN_TTL_MS: "" })).toBe(
			DEFAULT_LOGIN_TTL_MS,
		);
		expect(loginWaitMs({ WHOOP_LOGIN_WAIT_MS: "150" })).toBe(150);
		expect(loginAttemptLifetimeMs({ WHOOP_LOGIN_TTL_MS: "1500" })).toBe(1_500);

		// A value no timer can honour is a gate problem for every command, not
		// just for login.
		for (const command of COMMANDS) {
			for (const nonsense of ["soon", "0", "-1", "2.5", "4294967296"]) {
				expect(
					environmentProblems({ WHOOP_LOGIN_WAIT_MS: nonsense }, command),
				).toContain("WHOOP_LOGIN_WAIT_MS");
				expect(
					environmentProblems({ WHOOP_LOGIN_TTL_MS: nonsense }, command),
				).toContain("WHOOP_LOGIN_TTL_MS");
			}
		}

		// A name this server reads must not be warned about as a likely typo.
		const configured = {
			WHOOP_LOGIN_WAIT_MS: String(DEFAULT_LOGIN_WAIT_MS),
			WHOOP_LOGIN_TTL_MS: String(DEFAULT_LOGIN_TTL_MS),
		};
		for (const command of COMMANDS) {
			expect(environmentProblems(configured, command)).toBeUndefined();
			expect(environmentWarnings(configured, command)).toBeUndefined();
		}

		// The readers fall back to the default for values the gate would refuse,
		// rather than to a timer nobody meant.
		expect(loginWaitMs({ WHOOP_LOGIN_WAIT_MS: "soon" })).toBe(
			DEFAULT_LOGIN_WAIT_MS,
		);
		expect(loginAttemptLifetimeMs({ WHOOP_LOGIN_TTL_MS: "0" })).toBe(
			DEFAULT_LOGIN_TTL_MS,
		);
	});
});

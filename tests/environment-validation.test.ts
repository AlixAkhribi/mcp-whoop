import { describe, expect, it } from "vitest";

import { environmentProblems, environmentWarnings } from "@/config/environment";

/**
 * A complete, well-formed WHOOP environment. Cases override one variable at a
 * time, so each failure below has exactly one cause.
 */
function completeEnvironment(
	overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
	return {
		WHOOP_CLIENT_ID: "client-id",
		WHOOP_CLIENT_SECRET: "client-secret",
		WHOOP_REDIRECT_URI: "http://127.0.0.1:8788/callback",
		WHOOP_API_BASE_URL: "https://api.prod.whoop.com",
		WHOOP_HTTP_TIMEOUT_MS: "30000",
		WHOOP_TOKEN_STORE: "somewhere/else",
		WHOOP_SCOPES: "read:profile, read:sleep offline",
		...overrides,
	};
}

describe("the environment gate", () => {
	it("accepts an environment saying nothing at all", () => {
		// Serving runs on the stored login alone, so absence is never a problem.
		expect(environmentProblems({})).toBeUndefined();
	});

	it("accepts a complete, well-formed environment", () => {
		expect(environmentProblems(completeEnvironment())).toBeUndefined();
	});

	it("treats blank as unset rather than malformed", () => {
		expect(
			environmentProblems(
				completeEnvironment({
					WHOOP_API_BASE_URL: "   ",
					WHOOP_HTTP_TIMEOUT_MS: "",
					WHOOP_REDIRECT_URI: "\t",
					WHOOP_SCOPES: " ",
				}),
			),
		).toBeUndefined();
	});

	it("rejects a redirect URI that is not a URL", () => {
		const problems = environmentProblems(
			completeEnvironment({ WHOOP_REDIRECT_URI: "not a url" }),
		);

		expect(problems).toContain("WHOOP_REDIRECT_URI");
	});

	it("rejects a base URL that is not http(s)", () => {
		for (const value of ["api.prod.whoop.com", "ftp://api.prod.whoop.com"]) {
			expect(
				environmentProblems(completeEnvironment({ WHOOP_API_BASE_URL: value })),
			).toContain("WHOOP_API_BASE_URL");
		}
	});

	it("accepts the localhost origins a proxy or test double serves", () => {
		for (const value of [
			"http://127.0.0.1:9999",
			"http://localhost:8080/",
			"http://localhost:8080/whoop",
		]) {
			expect(
				environmentProblems(completeEnvironment({ WHOOP_API_BASE_URL: value })),
			).toBeUndefined();
		}
	});

	it("rejects a base URL carrying a query or fragment", () => {
		// Endpoint paths are appended to the base as text, so a query or
		// fragment swallows them — including the bare `?`, which parses to an
		// empty search yet corrupts the joined URL all the same.
		for (const value of [
			"https://example.com?tenant=a",
			"https://example.com#fragment",
			"https://example.com?",
		]) {
			expect(
				environmentProblems(completeEnvironment({ WHOOP_API_BASE_URL: value })),
			).toContain("WHOOP_API_BASE_URL");
		}
	});

	it("rejects a timeout that is not a whole number of milliseconds", () => {
		// The upper bound is Node's timer ceiling: `AbortSignal.timeout` throws
		// on fractions, throws above 2^32 - 1, and silently turns anything
		// between the ceilings into a 1 ms timer.
		for (const value of [
			"soon",
			"5s",
			"0",
			"-3",
			"Infinity",
			"NaN",
			"0.5",
			"2147483648",
			"4294967296",
		]) {
			expect(
				environmentProblems(
					completeEnvironment({ WHOOP_HTTP_TIMEOUT_MS: value }),
				),
			).toContain("WHOOP_HTTP_TIMEOUT_MS");
		}
	});

	it("accepts every whole timeout Node's timers can honor", () => {
		for (const value of ["1", "2147483647"]) {
			expect(
				environmentProblems(
					completeEnvironment({ WHOOP_HTTP_TIMEOUT_MS: value }),
				),
			).toBeUndefined();
		}
	});

	it("rejects scopes this server cannot ask for, without echoing them", () => {
		const problems = environmentProblems(
			completeEnvironment({ WHOOP_SCOPES: "read:sleep read:sleeep" }),
		);

		expect(problems).toContain("WHOOP_SCOPES");
		expect(problems).not.toContain("read:sleeep");
		// The complaint names this server's vocabulary as the limit, so it
		// stays true when WHOOP defines a scope this build has never heard of.
		expect(problems).toContain("this server cannot ask");
	});

	it("never echoes an unknown WHOOP_SCOPES value, whatever its shape", () => {
		// A credential pasted into the wrong variable must not reach stderr:
		// this complaint prints before any secret is registered for scrubbing,
		// and no shape separates a lowercase-only secret from a scope.
		for (const pasted of [
			"S3cr3t-Va1ue-9000",
			"supersecretvalue",
			"client_secret",
			"my_client:secret_value",
		]) {
			const problems = environmentProblems(
				completeEnvironment({ WHOOP_SCOPES: `read:sleep ${pasted}` }),
			);

			expect(problems).toContain("WHOOP_SCOPES");
			expect(problems).toContain("not echoed");
			expect(problems).not.toContain(pasted);
		}
	});

	it("rejects a scope list that names nothing", () => {
		expect(
			environmentProblems(completeEnvironment({ WHOOP_SCOPES: ",," })),
		).toContain("WHOOP_SCOPES");
	});

	it("reports every problem at once, as a checklist", () => {
		const problems = environmentProblems(
			completeEnvironment({
				WHOOP_API_BASE_URL: "nowhere",
				WHOOP_HTTP_TIMEOUT_MS: "soon",
			}),
		);

		expect(problems).toContain("WHOOP_API_BASE_URL");
		expect(problems).toContain("WHOOP_HTTP_TIMEOUT_MS");
	});

	it("never echoes a credential", () => {
		const problems = environmentProblems(
			completeEnvironment({
				WHOOP_CLIENT_SECRET: "s3cr3t-value",
				WHOOP_HTTP_TIMEOUT_MS: "soon",
			}),
		);

		expect(problems).toBeDefined();
		expect(problems).not.toContain("s3cr3t-value");
	});
});

describe("the environment typo warning", () => {
	it("calls out WHOOP_ names this server does not read", () => {
		const warnings = environmentWarnings(
			completeEnvironment({ WHOOP_TIMEOUT_MS: "5000" }),
		);

		expect(warnings).toContain("WHOOP_TIMEOUT_MS");
	});

	it("stays silent for the names it reads and for foreign variables", () => {
		expect(
			environmentWarnings({ ...completeEnvironment(), PATH: "/usr/bin" }),
		).toBeUndefined();
	});
});

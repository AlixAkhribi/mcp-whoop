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
		WHOOP_LOG_LEVEL: "info",
		WHOOP_TOKEN_STORE: "somewhere/else",
		WHOOP_SCOPES: "read:profile, read:sleep offline",
		...overrides,
	};
}

// `login` is the widest surface — it reads every variable in the schema — so
// this block asks the gate about `login` to exercise the whole of it. Which
// command reads what is the subject of its own block below.
describe("the environment gate", () => {
	it("accepts an environment saying nothing at all", () => {
		// Serving runs on the stored login alone, so absence is never a problem.
		expect(environmentProblems({}, "login")).toBeUndefined();
	});

	it("accepts a complete, well-formed environment", () => {
		expect(environmentProblems(completeEnvironment(), "login")).toBeUndefined();
	});

	it("treats blank as unset rather than malformed", () => {
		expect(
			environmentProblems(
				completeEnvironment({
					WHOOP_API_BASE_URL: "   ",
					WHOOP_HTTP_TIMEOUT_MS: "",
					WHOOP_LOG_LEVEL: " ",
					WHOOP_REDIRECT_URI: "\t",
					WHOOP_SCOPES: " ",
				}),
				"login",
			),
		).toBeUndefined();
	});

	it("rejects a redirect URI that is not a URL", () => {
		const problems = environmentProblems(
			completeEnvironment({ WHOOP_REDIRECT_URI: "not a url" }),
			"login",
		);

		expect(problems).toContain("WHOOP_REDIRECT_URI");
	});

	it("rejects a base URL that is not http(s)", () => {
		for (const value of ["api.prod.whoop.com", "ftp://api.prod.whoop.com"]) {
			expect(
				environmentProblems(
					completeEnvironment({ WHOOP_API_BASE_URL: value }),
					"login",
				),
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
				environmentProblems(
					completeEnvironment({ WHOOP_API_BASE_URL: value }),
					"login",
				),
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
				environmentProblems(
					completeEnvironment({ WHOOP_API_BASE_URL: value }),
					"login",
				),
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
					"login",
				),
			).toContain("WHOOP_HTTP_TIMEOUT_MS");
		}
	});

	it("accepts every whole timeout Node's timers can honor", () => {
		for (const value of ["1", "2147483647"]) {
			expect(
				environmentProblems(
					completeEnvironment({ WHOOP_HTTP_TIMEOUT_MS: value }),
					"login",
				),
			).toBeUndefined();
		}
	});

	it("accepts every level the logger speaks", () => {
		for (const level of ["debug", "info", "warning", "error"]) {
			expect(
				environmentProblems(
					completeEnvironment({ WHOOP_LOG_LEVEL: level }),
					"login",
				),
			).toBeUndefined();
		}
	});

	it("rejects a log level the logger does not speak, listing the real ones", () => {
		const problems = environmentProblems(
			completeEnvironment({ WHOOP_LOG_LEVEL: "verbose" }),
			"login",
		);

		expect(problems).toContain("WHOOP_LOG_LEVEL");
		expect(problems).toContain("debug, info, warning, error");
	});

	it("rejects scopes this server cannot ask for, without echoing them", () => {
		const problems = environmentProblems(
			completeEnvironment({ WHOOP_SCOPES: "read:sleep read:sleeep" }),
			"login",
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
				"login",
			);

			expect(problems).toContain("WHOOP_SCOPES");
			expect(problems).toContain("not echoed");
			expect(problems).not.toContain(pasted);
		}
	});

	it("rejects a scope list that names nothing", () => {
		expect(
			environmentProblems(completeEnvironment({ WHOOP_SCOPES: ",," }), "login"),
		).toContain("WHOOP_SCOPES");
	});

	it("reports every problem at once, as a checklist", () => {
		const problems = environmentProblems(
			completeEnvironment({
				WHOOP_API_BASE_URL: "nowhere",
				WHOOP_HTTP_TIMEOUT_MS: "soon",
			}),
			"login",
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
			"login",
		);

		expect(problems).toBeDefined();
		expect(problems).not.toContain("s3cr3t-value");
	});
});

/**
 * The read surfaces, pinned. Read sets drift as commands gain and lose
 * variables, and the cost of missing that drift is the silent-ignore failure
 * this gate exists to prevent, so each side of the split is asserted rather
 * than left to the schema's shape.
 */
describe("the per-command surface", () => {
	const LOGIN_ONLY = {
		WHOOP_REDIRECT_URI: "not a url",
		WHOOP_SCOPES: "read:sleep read:sleeep",
	};

	it("does not stop serving or logout over a login-only variable", () => {
		// Serving never reads either one: an MCP host reports a server that
		// exits as failed, so a typo here would cost every tool for nothing.
		for (const command of ["stdio", "logout"] as const) {
			expect(
				environmentProblems(completeEnvironment(LOGIN_ONLY), command),
			).toBeUndefined();
		}
	});

	it("refuses login over the same values", () => {
		const problems = environmentProblems(
			completeEnvironment(LOGIN_ONLY),
			"login",
		);

		expect(problems).toContain("WHOOP_REDIRECT_URI");
		expect(problems).toContain("WHOOP_SCOPES");
	});

	it("still stops every command over a variable they all read", () => {
		for (const command of ["stdio", "login", "logout"] as const) {
			expect(
				environmentProblems(
					completeEnvironment({ WHOOP_HTTP_TIMEOUT_MS: "soon" }),
					command,
				),
			).toContain("WHOOP_HTTP_TIMEOUT_MS");
		}
	});

	it("reports a login-only problem to the other commands as a warning", () => {
		// Not stopped by it, but not silently swallowing it either: the same
		// checklist line, said where it costs nothing.
		const warnings = environmentWarnings(
			completeEnvironment({ WHOOP_REDIRECT_URI: "not a url" }),
			"stdio",
		);

		expect(warnings).toContain("WHOOP_REDIRECT_URI");
		expect(warnings).toContain("only `login` reads it");
		expect(warnings).toContain("must be the URL WHOOP sends the browser back");
	});

	it("leaves that warning to the refusal when login is what is running", () => {
		expect(
			environmentWarnings(
				completeEnvironment({ WHOOP_REDIRECT_URI: "not a url" }),
				"login",
			),
		).toBeUndefined();
	});

	it("never echoes a value in the demoted warning either", () => {
		const warnings = environmentWarnings(
			completeEnvironment({ WHOOP_SCOPES: "read:sleep S3cr3t-Va1ue-9000" }),
			"stdio",
		);

		expect(warnings).toContain("WHOOP_SCOPES");
		expect(warnings).not.toContain("S3cr3t-Va1ue-9000");
	});
});

describe("the environment typo warning", () => {
	it("calls out WHOOP_ names this server does not read", () => {
		const warnings = environmentWarnings(
			completeEnvironment({ WHOOP_TIMEOUT_MS: "5000" }),
			"stdio",
		);

		expect(warnings).toContain("WHOOP_TIMEOUT_MS");
	});

	it("stays silent for the names it reads and for foreign variables", () => {
		for (const command of ["stdio", "login", "logout"] as const) {
			expect(
				environmentWarnings(
					{ ...completeEnvironment(), PATH: "/usr/bin" },
					command,
				),
			).toBeUndefined();
		}
	});

	it("says both things at once when both are true", () => {
		const warnings = environmentWarnings(
			completeEnvironment({
				WHOOP_TIMEOUT_MS: "5000",
				WHOOP_REDIRECT_URI: "not a url",
			}),
			"stdio",
		);

		expect(warnings).toContain("WHOOP_TIMEOUT_MS");
		expect(warnings).toContain("WHOOP_REDIRECT_URI");
	});
});

import { describe, expect, it } from "vitest";

import { createLogger } from "@/lib/log";
import { registerSecrets } from "@/lib/redaction";

/** A logger writing into an array, stamped by a fixed clock. */
function collectingLogger(env: NodeJS.ProcessEnv = {}) {
	const lines: string[] = [];
	const logger = createLogger({
		env,
		write: (line) => lines.push(line),
		now: () => new Date("2026-08-08T12:00:00.000Z"),
	});

	return { lines, logger };
}

describe("the stderr logger", () => {
	it("speaks from info up by default, keeping debug quiet", () => {
		const { lines, logger } = collectingLogger();

		logger.debug("noise");
		logger.info("progress");
		logger.warning("trouble");
		logger.error("failure");

		expect(lines).toHaveLength(3);
		expect(lines.join("\n")).not.toContain("noise");
	});

	it("says everything when asked for debug", () => {
		const { lines, logger } = collectingLogger({ WHOOP_LOG_LEVEL: "debug" });

		logger.debug("noise");
		logger.info("progress");

		expect(lines).toHaveLength(2);
	});

	it("keeps only errors when asked for error", () => {
		const { lines, logger } = collectingLogger({ WHOOP_LOG_LEVEL: "error" });

		logger.debug("noise");
		logger.info("progress");
		logger.warning("trouble");
		logger.error("failure");

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("failure");
	});

	it("stamps each line with the clock and the level", () => {
		const { lines, logger } = collectingLogger();

		logger.info("hello");

		expect(lines).toEqual(["2026-08-08T12:00:00.000Z [info] hello"]);
	});

	it("treats blank and unrecognized levels as the default", () => {
		// Startup refuses a malformed WHOOP_LOG_LEVEL before anything logs, so
		// only a test can hand one in — and it must not widen what is written.
		for (const value of ["  ", "verbose"]) {
			const { lines, logger } = collectingLogger({ WHOOP_LOG_LEVEL: value });

			logger.debug("noise");
			logger.info("progress");

			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("progress");
		}
	});

	it("scrubs registered secrets from every line", () => {
		const { lines, logger } = collectingLogger();
		registerSecrets("log-test-secret-value");

		logger.error("WHOOP said: token log-test-secret-value is expired");

		expect(lines[0]).toContain("[redacted]");
		expect(lines[0]).not.toContain("log-test-secret-value");
	});

	it("scrubs secrets registered after the logger was created", () => {
		// The serving process builds its logger at startup, but tokens enter it
		// later — on the store read — so scrubbing must happen at write time.
		const { lines, logger } = collectingLogger();
		registerSecrets("late-registered-secret");

		logger.info("carrying late-registered-secret onward");

		expect(lines[0]).not.toContain("late-registered-secret");
	});
});

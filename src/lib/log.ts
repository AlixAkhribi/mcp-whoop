/**
 * @file Leveled diagnostics on stderr. Under `stdio`, stdout is the JSON-RPC
 * wire, so stderr is the one channel this process may narrate on — the stream
 * the MCP stdio transport reserves for exactly this. MCP hosts capture the
 * stream into their own log files. Every line is scrubbed through
 * {@link redactSecrets} on its way out, so a message quoting an upstream
 * failure cannot carry token material into those files.
 */

import { redactSecrets } from "@/lib/redaction";

/**
 * The levels this server speaks, least to most severe — the slice of the RFC
 * 5424 ladder it has something to say at. `WHOOP_LOG_LEVEL` names the least
 * severe level worth writing.
 */
export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;

/** One of {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * What stands when `WHOOP_LOG_LEVEL` says nothing: startup, outcomes and
 * trouble are told; per-request narration stays quiet.
 */
const DEFAULT_LEVEL: LogLevel = "info";

/** What a logger is resolved against. Every field defaults to the process. */
export type LoggerOptions = {
	/** Environment `WHOOP_LOG_LEVEL` is read from. */
	env?: NodeJS.ProcessEnv;
	/** Where finished lines go, one call per line. */
	write?: (line: string) => void;
	/** The clock lines are stamped with. */
	now?: () => Date;
};

/** A function per level; each writes one stamped, scrubbed line or nothing. */
export type Logger = Record<LogLevel, (message: string) => void>;

/**
 * Builds a logger over the given seams. The threshold is fixed at creation —
 * nothing rereads `WHOOP_LOG_LEVEL` once the process is up — and an
 * unrecognized value falls back to the default, a state only a test can
 * produce, since startup refuses a malformed value
 * (`src/config/environment.ts`) before anything logs.
 *
 * Scrubbing happens at write time, not creation time, so secrets registered
 * after the logger exists — tokens read from the store mid-serve — are still
 * scrubbed from every later line.
 */
export function createLogger({
	env = process.env,
	write = (line) => process.stderr.write(`${line}\n`),
	now = () => new Date(),
}: LoggerOptions = {}): Logger {
	const configured = env.WHOOP_LOG_LEVEL?.trim();
	const threshold = (LOG_LEVELS as readonly string[]).includes(configured ?? "")
		? (configured as LogLevel)
		: DEFAULT_LEVEL;
	const floor = LOG_LEVELS.indexOf(threshold);

	const writing = (level: LogLevel) => (message: string) => {
		if (LOG_LEVELS.indexOf(level) < floor) {
			return;
		}
		write(redactSecrets(`${now().toISOString()} [${level}] ${message}`));
	};

	return {
		debug: writing("debug"),
		info: writing("info"),
		warning: writing("warning"),
		error: writing("error"),
	};
}

/**
 * The logger this process shares: stderr, stamped by the real clock, as talky
 * as `WHOOP_LOG_LEVEL` allows. Commands and serving alike write through it, so
 * "diagnostics never touch stdout" is a property of the seam rather than a
 * discipline every call site keeps separately.
 */
export const log = createLogger();

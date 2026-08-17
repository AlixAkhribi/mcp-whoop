/**
 * @file Validates the whole `WHOOP_*` environment surface in one place, at
 * startup. Nothing here is required — serving runs on the stored login alone,
 * and `login` names the credentials it is missing itself — but a variable that
 * is set must parse. Left unchecked, a malformed value either dies cryptically
 * later (`new URL` throwing mid-request) or is silently ignored (a mistyped
 * timeout leaving the default standing), and both are worse than refusing to
 * start with a checklist of what to fix.
 */

import { z } from "zod";
import {
	DEFAULT_LOGIN_TTL_MS,
	DEFAULT_LOGIN_WAIT_MS,
} from "@/config/elicited-login";
import { DEFAULT_HTTP_TIMEOUT_MS } from "@/config/http";
import { MAX_TIMER_MS } from "@/config/timers";
import { LOG_LEVELS } from "@/lib/log";
import { splitScopes } from "@/whoop/auth/login/requested-scopes";
import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";

/**
 * Blank counts as unset, matching every reader: an exported-but-empty variable
 * is treated as absence, never validated as a value. Present values are
 * trimmed before validation for the same reason — the readers trim.
 */
function unsetWhenBlank(schema: z.ZodType) {
	return z.preprocess(
		(value) =>
			typeof value === "string" && value.trim() ? value.trim() : undefined,
		schema.optional(),
	);
}

/**
 * A millisecond duration Node's timers can honour. One complaint covers every
 * way it can fail, naming the variable's default as its example.
 */
function duration(what: string, byDefault: number) {
	const complaint = `must be ${what}, a whole number of milliseconds from 1 to ${MAX_TIMER_MS}, like ${byDefault}`;

	return z.coerce
		.number({ error: complaint })
		.int({ error: complaint })
		.min(1, { error: complaint })
		.max(MAX_TIMER_MS, { error: complaint });
}

/** Every scope this server could ever ask WHOOP for. */
const KNOWN_SCOPES = new Set<string>([...DEFAULT_READ_SCOPES, OFFLINE_SCOPE]);

/**
 * A `WHOOP_SCOPES` value: it may narrow the request however it likes, but a
 * scope this server does not know would only be refused at the consent
 * screen, long after the mistyping, so the strangers are counted here
 * instead. Counted, never echoed: no shape distinguishes a mistyped scope
 * from a pasted credential — the variable sits one paste away from the real
 * ones — and this complaint prints before the redaction layer has been told
 * any secrets, so silence is the only safe answer. The known-scope list in
 * the message is what lets a typo be spotted without the echo.
 */
const scopeListSchema = z.string().check((ctx) => {
	const named = splitScopes(ctx.value);
	if (named.length === 0) {
		ctx.issues.push({
			code: "custom",
			message: "names no scopes at all; unset it to ask for every read scope",
			input: ctx.value,
		});

		return;
	}

	const strangers = named.filter((scope) => !KNOWN_SCOPES.has(scope));
	if (strangers.length > 0) {
		ctx.issues.push({
			code: "custom",
			message: `names ${
				strangers.length === 1 ? "a scope" : `${strangers.length} scopes`
			} this server cannot ask WHOOP for, not echoed here in case a pasted secret is among them (it can ask for ${[
				...KNOWN_SCOPES,
			].join(", ")})`,
			input: ctx.value,
		});
	}
});

/**
 * The variables this server reads, each validated as its reader will use it.
 * The credentials and the store path are shapeless — any non-blank string
 * could be real, so only their presence can be judged, and that judgement
 * belongs to the login credential reader — but they are listed
 * so this object is the one complete account of the surface.
 */
const environmentSchema = z.object({
	WHOOP_CLIENT_ID: unsetWhenBlank(z.string()),
	WHOOP_CLIENT_SECRET: unsetWhenBlank(z.string()),
	WHOOP_REDIRECT_URI: unsetWhenBlank(
		z.url({
			error:
				"must be the URL WHOOP sends the browser back to, like http://127.0.0.1:8788/callback",
		}),
	),
	WHOOP_API_BASE_URL: unsetWhenBlank(
		z
			.url({
				protocol: /^https?$/,
				error:
					"must be an http(s) origin serving a WHOOP-shaped API, like https://api.prod.whoop.com",
			})
			// The raw characters, not the parsed components: a bare trailing `?`
			// or `#` parses to an empty search and hash yet still swallows every
			// appended endpoint path (`src/whoop/api/client/endpoints.ts`).
			.refine((base) => !/[?#]/.test(base), {
				error:
					"must carry no query or fragment: every endpoint path is appended to it and would land inside them",
			}),
	),
	WHOOP_HTTP_TIMEOUT_MS: unsetWhenBlank(
		duration("the bound every WHOOP request is given", DEFAULT_HTTP_TIMEOUT_MS),
	),
	WHOOP_LOGIN_WAIT_MS: unsetWhenBlank(
		duration(
			"how long a tool call waits for a login it offered inside a conversation before asking the client to come back",
			DEFAULT_LOGIN_WAIT_MS,
		),
	),
	WHOOP_LOGIN_TTL_MS: unsetWhenBlank(
		duration(
			"how long such a login keeps the loopback port it borrowed while nobody comes back to it",
			DEFAULT_LOGIN_TTL_MS,
		),
	),
	WHOOP_LOG_LEVEL: unsetWhenBlank(
		z.enum(LOG_LEVELS, {
			error: `must name how much the server says on stderr: ${LOG_LEVELS.join(
				", ",
			)}`,
		}),
	),
	WHOOP_TOKEN_STORE: unsetWhenBlank(z.string()),
	WHOOP_SCOPES: unsetWhenBlank(scopeListSchema),
});

/** The commands this gate can validate. */
export type Command = "stdio" | "login" | "logout";

/** What a demoted variable's warning is made of, for one command. */
type Demotion = {
	/** What a malformed value costs the command that is running. */
	readonly cost: string;
	/** What the reader does about it, and what fixing it buys back. */
	readonly remedy: string;
};

/**
 * The variables only `login` refuses over. `WHOOP_SCOPES` is read by nothing
 * else. `WHOOP_REDIRECT_URI` is read while serving too (to offer a login
 * inside a conversation), but stays demoted: an MCP host treats an exiting
 * server as failed with every tool gone, and `.env.example` invites copying
 * the login block into the server entry, so a typo there must cost only the
 * offer. Each warning states whether the variable is unread or read-but-
 * unusable under the running command.
 */
const DEMOTED: Record<string, (command: Command) => Demotion> = {
	WHOOP_REDIRECT_URI: (command) =>
		command === "stdio"
			? {
					cost: "WHOOP_REDIRECT_URI does not parse, so no WHOOP login can be offered inside a conversation: a tool call that finds no stored login is answered with instructions to log in from a terminal instead.",
					remedy:
						"`stdio` serves on regardless. Fix it to have that offer back, and before the next `mcp-whoop login`, which does refuse over it.",
				}
			: {
					cost: `Ignoring WHOOP_REDIRECT_URI: \`${command}\` does not read it.`,
					remedy: `\`${command}\` carries on. Fix it before the next \`mcp-whoop login\`.`,
				},
	WHOOP_SCOPES: (command) => ({
		cost: "Ignoring WHOOP_SCOPES: only `login` reads it, and `login` is not what is running.",
		remedy: `\`${command}\` carries on. Fix it before the next \`mcp-whoop login\`.`,
	}),
};

/** Every complaint this environment earns, by variable name. */
function complaintsIn(
	env: NodeJS.ProcessEnv,
): Partial<Record<string, string[]>> {
	const parsed = environmentSchema.safeParse(env);

	return parsed.success ? {} : z.flattenError(parsed.error).fieldErrors;
}

/**
 * The `  - NAME complaint` lines for the variables `wanted` selects, in the
 * order the schema declares them.
 */
function checklist(
	complaints: Partial<Record<string, string[]>>,
	wanted: (name: string) => boolean,
): string[] {
	return Object.keys(environmentSchema.shape)
		.filter(wanted)
		.flatMap((name) =>
			(complaints[name] ?? []).map((complaint) => `  - ${name} ${complaint}`),
		);
}

/**
 * The problems that stop `command`, one checklist line per misconfigured
 * variable in schema order, or undefined when nothing stands in its way.
 * {@link DEMOTED} variables are left to {@link environmentWarnings}. Values
 * are never echoed back — one of the variables is a secret.
 */
export function environmentProblems(
	env: NodeJS.ProcessEnv,
	command: Command,
): string | undefined {
	const lines = checklist(
		complaintsIn(env),
		(name) => command === "login" || !(name in DEMOTED),
	);
	if (lines.length === 0) {
		return undefined;
	}

	return [
		"Cannot start mcp-whoop: the environment misconfigures it.",
		...lines,
		"",
		"Every WHOOP_* variable is optional. Fix the ones above where this process's environment is defined — the `env` of an MCP client's server entry, or the shell that ran this command — or unset them.",
	].join("\n");
}

/**
 * The warning a `WHOOP_*` name this server does not read earns: it is almost
 * certainly a mistyped one — `WHOOP_TIMEOUT_MS` for `WHOOP_HTTP_TIMEOUT_MS` —
 * and would otherwise be ignored without a trace. Only a warning, never a
 * refusal, because the prefix is not owned: another WHOOP tool on the same
 * machine may export names of its own. Which command is running makes no
 * difference to it — a name nothing reads is a typo under all of them.
 */
function strangerWarning(env: NodeJS.ProcessEnv): string | undefined {
	const strangers = Object.keys(env)
		.filter(
			(name) => name.startsWith("WHOOP_") && !(name in environmentSchema.shape),
		)
		.sort();
	if (strangers.length === 0) {
		return undefined;
	}

	return [
		`Ignoring ${strangers.join(", ")}: no WHOOP setting has ${
			strangers.length === 1 ? "that name" : "those names"
		}.`,
		`This server reads ${Object.keys(environmentSchema.shape).join(", ")}.`,
	].join("\n");
}

/**
 * The warning each malformed {@link DEMOTED} variable earns under commands it
 * does not stop: the checklist line `login` would refuse over, wrapped in
 * what the running command loses by it. One block per variable, since what
 * they cost differs.
 */
function demotedWarnings(env: NodeJS.ProcessEnv, command: Command): string[] {
	if (command === "login") {
		return [];
	}

	const complaints = complaintsIn(env);

	return Object.keys(environmentSchema.shape)
		.filter((name) => name in DEMOTED && (complaints[name]?.length ?? 0) > 0)
		.map((name) => {
			const { cost, remedy } = DEMOTED[name](command);

			return [
				cost,
				...checklist(complaints, (other) => other === name),
				remedy,
			].join("\n");
		});
}

/**
 * The warnings this environment earns under `command`, or undefined when it
 * earns none: a `WHOOP_*` name nothing reads, and a variable `command` will not
 * be stopped by. Both are things worth saying that are not worth refusing over.
 */
export function environmentWarnings(
	env: NodeJS.ProcessEnv,
	command: Command,
): string | undefined {
	const blocks = [
		strangerWarning(env),
		...demotedWarnings(env, command),
	].filter((block) => block !== undefined);

	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

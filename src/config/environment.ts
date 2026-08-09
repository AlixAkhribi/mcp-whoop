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

import { MAX_TIMEOUT_MS } from "@/api/client/http";
import {
	DEFAULT_READ_SCOPES,
	OFFLINE_SCOPE,
	splitScopes,
} from "@/auth/login/requested-scopes";
import { LOG_LEVELS } from "@/lib/log";

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

/** One complaint fits every way a timeout can fail to be one. */
const TIMEOUT_COMPLAINT = `must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, like 30000`;

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
 * belongs to `login` (`src/auth/login/environment.ts`) — but they are listed
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
			// appended endpoint path (`src/api/client/endpoints.ts`).
			.refine((base) => !/[?#]/.test(base), {
				error:
					"must carry no query or fragment: every endpoint path is appended to it and would land inside them",
			}),
	),
	WHOOP_HTTP_TIMEOUT_MS: unsetWhenBlank(
		z.coerce
			.number({ error: TIMEOUT_COMPLAINT })
			.int({ error: TIMEOUT_COMPLAINT })
			.min(1, { error: TIMEOUT_COMPLAINT })
			.max(MAX_TIMEOUT_MS, { error: TIMEOUT_COMPLAINT }),
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

/** The commands this gate can be asked about (`src/index.ts` dispatches them). */
export type Command = "stdio" | "login" | "logout";

/**
 * The variables `login` alone reads: the redirect it sends the browser back to
 * (`src/auth/login/environment.ts`) and the scopes it asks for
 * (`src/auth/login/requested-scopes.ts`). Everything else in the schema is read
 * by every command, so absence from this set — the default for anything added
 * later — means "gated everywhere", which errs toward the loud failure this
 * gate exists to produce rather than the silent one.
 *
 * The split exists because serving must not be killable by a value it never
 * consumes: an MCP host reports a server that exits as failed and every tool
 * disappears with it, and `.env.example` invites copying the whole login block
 * into that server entry, so a typo'd redirect URI there is a realistic way to
 * lose WHOOP access entirely. Under a command that does not read them these
 * two are demoted to a warning, never ignored.
 */
const LOGIN_ONLY = new Set<string>(["WHOOP_REDIRECT_URI", "WHOOP_SCOPES"]);

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
 * The problems with this environment that stand in `command`'s way, as the
 * user should read them: one line per misconfigured variable `command` reads,
 * in the order the schema declares them, or undefined when everything it reads
 * parses. A variable outside its surface ({@link LOGIN_ONLY}) is left to
 * {@link environmentWarnings}. Values are never echoed back — the checklist
 * names variables, and one of them is a secret.
 */
export function environmentProblems(
	env: NodeJS.ProcessEnv,
	command: Command,
): string | undefined {
	const lines = checklist(
		complaintsIn(env),
		(name) => command === "login" || !LOGIN_ONLY.has(name),
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
 * What a malformed {@link LOGIN_ONLY} variable earns under a command that
 * never reads it: the same checklist line `login` would refuse over, said as a
 * warning. The value is not silently swallowed — that is the failure this gate
 * exists to prevent — but it does not take down a command it has no bearing
 * on either.
 */
function loginOnlyWarning(
	env: NodeJS.ProcessEnv,
	command: Command,
): string | undefined {
	if (command === "login") {
		return undefined;
	}

	const complaints = complaintsIn(env);
	const broken = Object.keys(environmentSchema.shape).filter(
		(name) => LOGIN_ONLY.has(name) && (complaints[name]?.length ?? 0) > 0,
	);
	if (broken.length === 0) {
		return undefined;
	}

	const one = broken.length === 1;

	return [
		`Ignoring ${broken.join(", ")}: only \`login\` reads ${
			one ? "it" : "them"
		}, and \`login\` is not what is running.`,
		...checklist(complaints, (name) => broken.includes(name)),
		`\`${command}\` carries on. Fix ${
			one ? "it" : "them"
		} before the next \`mcp-whoop login\`.`,
	].join("\n");
}

/**
 * The warnings this environment earns under `command`, or undefined when it
 * earns none: a `WHOOP_*` name nothing reads, and a login-only variable
 * `command` will not be stopped by. Both are things worth saying that are not
 * worth refusing over.
 */
export function environmentWarnings(
	env: NodeJS.ProcessEnv,
	command: Command,
): string | undefined {
	const blocks = [strangerWarning(env), loginOnlyWarning(env, command)].filter(
		(block) => block !== undefined,
	);

	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

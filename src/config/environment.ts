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

/**
 * The problems with this environment, as the user should read them: one line
 * per misconfigured variable, in the order the schema declares them, or
 * undefined when everything set parses. Values are never echoed back — the
 * checklist names variables, and one of them is a secret.
 */
export function environmentProblems(
	env: NodeJS.ProcessEnv,
): string | undefined {
	const parsed = environmentSchema.safeParse(env);
	if (parsed.success) {
		return undefined;
	}

	const complaints: Partial<Record<string, string[]>> = z.flattenError(
		parsed.error,
	).fieldErrors;
	const lines = Object.keys(environmentSchema.shape).flatMap((name) =>
		(complaints[name] ?? []).map((complaint) => `  - ${name} ${complaint}`),
	);

	return [
		"Cannot start mcp-whoop: the environment misconfigures it.",
		...lines,
		"",
		"Every WHOOP_* variable is optional. Fix the ones above where this process's environment is defined — the `env` of an MCP client's server entry, or the shell that ran this command — or unset them.",
	].join("\n");
}

/**
 * The warning this environment earns, or undefined when it earns none: a
 * `WHOOP_*` name this server does not read is almost certainly a mistyped one
 * — `WHOOP_TIMEOUT_MS` for `WHOOP_HTTP_TIMEOUT_MS` — and would otherwise be
 * ignored without a trace. Only a warning, never a refusal, because the
 * prefix is not owned: another WHOOP tool on the same machine may export
 * names of its own.
 */
export function environmentWarnings(
	env: NodeJS.ProcessEnv,
): string | undefined {
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

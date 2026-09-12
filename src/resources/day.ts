import {
	type McpServer,
	ResourceNotFoundError,
	ResourceTemplate,
	type ServerContext,
	type Variables,
} from "@modelcontextprotocol/server";

import { formatJson } from "@/json";
import { NoSuchDayError } from "@/whoop/reads/day";
import { readDaySnapshot } from "@/whoop/reads/day-snapshot";
import type { DaySnapshot } from "@/whoop/reads/day-snapshot-model";
import {
	datesStartingWith,
	readRecentWakeDates,
} from "@/whoop/reads/recent-days";
import { observedCompleter, observedTemplateResource } from "./observed";
import {
	RESOURCE_ANNOTATIONS,
	RESOURCE_CACHE_HINT,
	RESOURCE_MIME_TYPE,
} from "./policy";

/** The family this template advertises: one day's snapshot, named by its date. */
const DAY_URI_TEMPLATE = "whoop://day/{date}";

export function registerDayResource(server: McpServer): void {
	server.registerResource(
		"whoop_day",
		// Never enumerated: `list: undefined` is how the SDK is told this family
		// has no members to fold into `resources/list`, which stays the fixed set
		// a user picks whole. A member exists only when WHOOP holds the cycle its
		// date names, and no listing this server could write would stay true.
		//
		// Completed instead: a family is reached by filling its variable in, and
		// a date is the one thing about a day a user cannot look up. What a
		// completion offers is not a listing — it is the days themselves, asked
		// for at the moment someone types, and true only then.
		new ResourceTemplate(DAY_URI_TEMPLATE, {
			list: undefined,
			complete: { date: observedCompleter(DAY_URI_TEMPLATE, completeDate) },
		}),
		{
			title: "WHOOP day",
			description:
				'One day on WHOOP, as a snapshot to attach to a conversation: the physiological cycle that day was, the recovery scored for it, and the sleep that started it. The date is the morning you woke — the date your WHOOP app shows for the day — written as YYYY-MM-DD; a night is reached by the morning it ended on. The same answer the "get_today_snapshot" tool and "whoop://today" give for today, for any day the user this server is logged in as has lived.',
			mimeType: RESOURCE_MIME_TYPE,
			// No `lastModified`: a family has no modification time of its own, and
			// WHOOP rescores a day for as long as it holds it, so this server knows
			// of no instant any member was last modified at and claims none.
			annotations: RESOURCE_ANNOTATIONS,
			cacheHint: RESOURCE_CACHE_HINT,
		},
		observedTemplateResource(
			async (uri: URL, variables: Variables, ctx: ServerContext) => {
				const snapshot = await readMember(uri, filledDate(variables), {
					signal: ctx.mcpReq.signal,
				});

				return {
					contents: [
						{
							uri: uri.href,
							mimeType: RESOURCE_MIME_TYPE,
							text: formatJson(snapshot),
						},
					],
				};
			},
		),
	);
}

/**
 * The dates a user could still be typing: the days this login has recently
 * lived, narrowed to those the half-typed value is the start of.
 *
 * Labeled by the read's own rule and gated by the read's own scopes, because it
 * is the read's own machinery that answers it — a suggestion is only worth
 * offering if reading it would answer, and a date named one way here and
 * another way there would be exactly the day this server cannot speak for.
 */
async function completeDate(typed: string): Promise<string[]> {
	return datesStartingWith(await readRecentWakeDates(), typed);
}

/**
 * The day one member of the family holds, or the refusal a member that does
 * not exist is answered with: a date naming nothing this server can speak for
 * is a miss, and the 2026-07-28 revision refuses a `resources/read` miss as
 * invalid params with the requested URI echoed in the error data. So the
 * member URI — the thing the client actually asked for, which the read itself
 * never sees — is put back on the way out.
 *
 * Everything else is left alone: a login that has to be redone, a scope that
 * was never granted, a WHOOP that refused or could not be reached are all this
 * server failing to answer a day that exists, and stay the internal error they
 * are today.
 */
async function readMember(
	uri: URL,
	date: string,
	{ signal }: { signal?: AbortSignal },
): Promise<DaySnapshot> {
	try {
		return await readDaySnapshot(date, { signal });
	} catch (error) {
		if (error instanceof NoSuchDayError) {
			throw new ResourceNotFoundError(uri.href, error.message);
		}

		throw error;
	}
}

/**
 * The date a client filled `{date}` with. A simple template expression matches
 * one value, so the list form the SDK's type allows never occurs here; the
 * first of one would still be the nearest thing to what was asked, and the read
 * judges the value itself either way.
 */
function filledDate(variables: Variables): string {
	const date = variables.date;

	return Array.isArray(date) ? (date[0] ?? "") : date;
}

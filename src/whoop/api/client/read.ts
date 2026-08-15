import type { z } from "zod";

import { registerSecrets } from "@/lib/redaction";
import { WhoopUnauthorizedError } from "./errors";
import { classifiedWhoopFailure, whoopFetch } from "./http";

/** WHOOP's shared collection query, in its documented field names. */
export type WhoopPageQuery = {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
};

type ReadWhoopJsonRequest<T, Absent> = {
	readonly operation: string;
	readonly endpoint: URL;
	readonly accessToken: string;
	readonly schema: z.ZodType<T>;
	readonly env?: NodeJS.ProcessEnv;
	readonly query?: WhoopPageQuery;
	readonly signal?: AbortSignal;
	readonly notFound?: () => Absent;
};

/**
 * Runs the shared bearer-read policy: query mapping, transport bounds,
 * authorization status, absence handling, error classification, and schema
 * validation.
 */
async function readParsed<T, Absent>({
	operation,
	endpoint,
	accessToken,
	schema,
	env,
	query,
	signal,
	notFound,
}: ReadWhoopJsonRequest<T, Absent>): Promise<T | Absent> {
	if (query) {
		for (const [name, value] of Object.entries(query)) {
			if (value !== undefined) {
				endpoint.searchParams.set(name, String(value));
			}
		}
	}

	registerSecrets(accessToken);
	const response = await whoopFetch({
		operation,
		url: endpoint,
		env,
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
		},
		signal,
	});

	if (response.status === 401) {
		throw new WhoopUnauthorizedError();
	}
	if (response.status === 404 && notFound) {
		return notFound();
	}

	const body = await response.text();
	if (!response.ok) {
		throw classifiedWhoopFailure(operation, response, body);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		payload = undefined;
	}
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`WHOOP answered ${operation} with an unexpected body`);
	}

	return parsed.data;
}

type RequiredReadRequest<T> = Omit<
	ReadWhoopJsonRequest<T, never>,
	"notFound"
> & {
	readonly notFound?: () => Error;
};

/** Reads and validates a required WHOOP JSON response. */
export function readWhoopJson<T>(request: RequiredReadRequest<T>): Promise<T> {
	const { notFound, ...rest } = request;

	return readParsed({
		...rest,
		notFound:
			notFound &&
			(() => {
				throw notFound();
			}),
	});
}

/** Reads and validates a WHOOP JSON response whose 404 means absence. */
export function readWhoopJsonOrAbsent<T>(
	request: Omit<ReadWhoopJsonRequest<T, null>, "notFound">,
): Promise<T | null> {
	return readParsed({ ...request, notFound: () => null });
}

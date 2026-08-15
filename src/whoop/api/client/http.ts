import { whoopRequestTimeoutMs } from "@/config/http";
import { OperationCancelledError } from "@/lib/cancellation";
import { log } from "@/lib/log";
import { describeRedacted, redactedExcerpt } from "@/lib/redaction";
import { WhoopTimeoutError } from "./errors";

/** The request details shared by every WHOOP-facing operation. */
type WhoopFetchOptions = {
	readonly operation: string;
	readonly url: URL;
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	readonly method?: string;
	readonly headers?: HeadersInit;
	readonly body?: BodyInit;
};

/** The response surface callers need, with body reads kept in the policy. */
type WhoopResponse = {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: Headers;
	text(): Promise<string>;
};

type RequestContext = {
	readonly operation: string;
	readonly method: string;
	readonly path: string;
	readonly callerSignal?: AbortSignal;
	readonly timeoutSignal: AbortSignal;
};

function transportFailure(context: RequestContext, cause: unknown): never {
	if (context.callerSignal?.aborted) {
		log.debug(
			`${context.method} ${context.path} was cancelled for ${context.operation}`,
		);
		throw new OperationCancelledError(
			`${context.operation} was cancelled before WHOOP finished answering.`,
		);
	}

	if (context.timeoutSignal.aborted) {
		log.warning(
			`${context.method} ${context.path} timed out for ${context.operation}`,
		);
		throw new WhoopTimeoutError(context.operation);
	}

	log.warning(
		`${context.method} ${context.path} got no answer for ${context.operation}: ${describeRedacted(cause)}`,
	);
	throw new Error(
		`WHOOP could not be reached for ${context.operation}: a network failure, not a WHOOP answer. It is safe to retry once the connection is back.`,
	);
}

/**
 * Performs a bounded WHOOP request without ever logging query values, headers,
 * or bodies. The returned body reader retains the same cancellation and
 * timeout classification after response headers have arrived.
 */
export async function whoopFetch({
	operation,
	url,
	env = process.env,
	signal,
	method = "GET",
	headers,
	body,
}: WhoopFetchOptions): Promise<WhoopResponse> {
	const timeoutSignal = AbortSignal.timeout(whoopRequestTimeoutMs(env));
	const context: RequestContext = {
		operation,
		method,
		path: url.pathname,
		callerSignal: signal,
		timeoutSignal,
	};
	const combinedSignal = signal
		? AbortSignal.any([signal, timeoutSignal])
		: timeoutSignal;
	const started = performance.now();

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers,
			body,
			signal: combinedSignal,
		});
	} catch (cause) {
		transportFailure(context, cause);
	}

	log.debug(
		`${method} ${url.pathname} answered ${response.status} for ${operation} in ${Math.round(performance.now() - started)}ms`,
	);

	return {
		ok: response.ok,
		status: response.status,
		headers: response.headers,
		async text() {
			try {
				return await response.text();
			} catch (cause) {
				transportFailure(context, cause);
			}
		},
	};
}

/** Whether a retry could plausibly get past this status. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

type FailedAnswer = {
	status: number;
	headers: { get(name: string): string | null };
};

function retryAfterWait(headers: FailedAnswer["headers"]): string {
	for (const name of ["retry-after", "x-ratelimit-reset"]) {
		const header = headers.get(name);
		const seconds = Number(header);
		if (header && Number.isFinite(seconds) && seconds >= 0) {
			return `about ${Math.ceil(seconds)} seconds`;
		}
	}

	return "a short wait";
}

function whoopMessageIn(body: string): string | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof payload !== "object" || payload === null) {
		return undefined;
	}

	for (const field of ["message", "error_description", "error"]) {
		const value = (payload as Record<string, unknown>)[field];
		if (typeof value === "string" && value.trim()) {
			return redactedExcerpt(value.trim());
		}
	}

	return undefined;
}

/** Builds the actionable error for a non-successful WHOOP response. */
export function classifiedWhoopFailure(
	operation: string,
	response: FailedAnswer,
	body: string,
): Error {
	if (response.status === 429) {
		return new Error(
			`WHOOP rate-limited ${operation} (HTTP 429). It is safe to retry after ${retryAfterWait(response.headers)}.`,
		);
	}

	if (response.status >= 500) {
		return new Error(
			`WHOOP is temporarily unavailable (HTTP ${response.status}): ${operation} hit an outage on WHOOP's side. It is safe to retry shortly.`,
		);
	}

	const upstreamMessage = whoopMessageIn(body);

	return new Error(
		`WHOOP rejected ${operation} (HTTP ${response.status})${
			upstreamMessage ? `: ${upstreamMessage}` : ""
		}. Retrying will not help.`,
	);
}

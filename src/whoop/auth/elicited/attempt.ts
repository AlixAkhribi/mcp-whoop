/**
 * @file In-memory registry of elicited login attempts: WHOOP logins driven
 * from inside an MCP conversation instead of a terminal.
 *
 * An attempt holds the OAuth `state` and the loopback listener for the
 * redirect. Only {@link LoginAttempt.requestState} — an unguessable opaque
 * handle — travels to the client, and the token store, re-read on every call,
 * stays the ground truth; a tampered handle can at worst name no attempt.
 *
 * Each token store has at most one attempt at a time, and concurrent calls
 * join it rather than racing for the single redirect port. An attempt ends —
 * releasing the port — when the redirect is answered, the user refuses, its
 * lifetime expires, or the client disconnects ({@link endLoginAttempt},
 * {@link endEveryLoginAttempt}).
 */

import { randomBytes } from "node:crypto";

import { loginAttemptLifetimeMs, loginWaitMs } from "@/config/elicited-login";
import { log } from "@/lib/log";
import { exchangeAuthorizationCode } from "@/whoop/api/oauth/token-exchange";
import {
	missingApplicationVariables,
	type ResolvedApplication,
	resolveApplication,
} from "@/whoop/auth/application";
import { buildAuthorizeUrl } from "@/whoop/auth/login/authorize-url";
import {
	DEVELOPER_DASHBOARD,
	loginChecklist,
	missingCredentialsMessage,
} from "@/whoop/auth/login/checklist";
import {
	applicationRecord,
	type WhoopAppCredentials,
} from "@/whoop/auth/login/credentials";
import {
	isLoopbackRedirect,
	type LoopbackRedirectCapture,
	listenForRedirect,
} from "@/whoop/auth/login/redirect-listener";
import { DEFAULT_READ_SCOPES, OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";
import {
	readStoredTokens,
	resolveTokenStorePath,
	writeStoredTokens,
} from "@/whoop/auth/tokens/store";

/**
 * Scopes an elicited login requests: every read scope plus `offline`, which
 * makes WHOOP issue the rotating refresh token. `WHOOP_SCOPES` narrows the
 * login command only and is not read while serving.
 */
const ELICITED_SCOPES = [...DEFAULT_READ_SCOPES, OFFLINE_SCOPE];

/** Bytes of randomness in attempt names and OAuth state values. */
const UNGUESSABLE_BYTES = 32;

/** Generates a cryptographically random, URL-safe identifier. */
function unguessable(): string {
	return randomBytes(UNGUESSABLE_BYTES).toString("base64url");
}

/**
 * Exchanges the authorization code for tokens and persists them. Runs when
 * WHOOP's redirect arrives rather than on the client's retry, so the login
 * completes even for a client that never retries.
 */
async function completeLogin(
	code: string,
	app: WhoopAppCredentials,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const tokens = await exchangeAuthorizationCode({
		env,
		app,
		code,
		requested: ELICITED_SCOPES,
	});
	// The application is stored with the tokens: WHOOP re-authenticates it on
	// every refresh, and the process may restart without the environment that
	// configured it (ADR 0003).
	await writeStoredTokens(
		{ ...tokens, application: applicationRecord(app) },
		{ env },
	);
	log.info(`logged in to WHOOP; granted scopes: ${tokens.scopes.join(" ")}`);
}

/** An attempt this process has started and not yet seen end. */
type PendingAttempt = {
	/** Path of the token store the login would be written to. */
	readonly store: string;
	/**
	 * Resolves once the attempt is over — completed with the store written,
	 * refused, expired, or shut down. The port is released either way.
	 */
	readonly over: Promise<void>;
	/** Closes the listener and clears the expiry timer. */
	readonly end: () => Promise<void>;
};

/** Attempts in flight, keyed by the request state sent to the client. */
const inFlight = new Map<string, PendingAttempt>();

/**
 * The single attempt allowed per token store, keyed by store path. Holds the
 * still-starting promise so a call arriving while the listener is being bound
 * joins the attempt instead of racing it for the redirect port.
 */
const perStore = new Map<string, Promise<StartedLogin>>();

/** Clears a store's entry if it still belongs to the given attempt. */
function release(store: string, starting: Promise<StartedLogin>): void {
	if (perStore.get(store) === starting) {
		perStore.delete(store);
	}
}

/**
 * Ends the attempt the given name stands for: closes the listener, releases
 * the port, and frees the store for a new attempt. A name that matches no
 * attempt ends nothing, which is why a client-supplied value is safe to take
 * at face value. Ending resolves `over` for every call that joined.
 */
export async function endLoginAttempt(
	requestState: string | undefined,
): Promise<void> {
	if (requestState === undefined) {
		return;
	}
	const attempt = inFlight.get(requestState);
	if (!attempt) {
		return;
	}
	inFlight.delete(requestState);
	// A store holds one attempt at a time, so the perStore entry is this one's.
	perStore.delete(attempt.store);
	await attempt.end();
}

/**
 * Whether the client has disconnected. Set before the in-flight table is
 * drained and never cleared: a start past the table check but not yet
 * registered would otherwise slip through the drain and leave its listener
 * holding the process open until the attempt's lifetime ran out.
 */
let closing = false;

/**
 * Ends every attempt and refuses new ones. Called when the client
 * disconnects: an open listener would otherwise keep the process and its
 * loopback port alive with nobody left to answer the consent screen.
 */
export async function endEveryLoginAttempt(): Promise<void> {
	closing = true;
	await Promise.all(
		[...inFlight.keys()].map((requestState) => endLoginAttempt(requestState)),
	);
}

/** Outcome of waiting on the attempt a retry names. */
export type AwaitedAttempt =
	/** No attempt in this process has that name. */
	| "no-attempt"
	/** The attempt ended; the token store holds the outcome. */
	| "over"
	/** The wait budget elapsed with the attempt still in progress. */
	| "waiting";

/** Whether `work` settles within `ms`. Clears the timer either way. */
function within(work: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const budget = setTimeout(() => resolve(false), ms);
		const finished = (): void => {
			clearTimeout(budget);
			resolve(true);
		};
		void work.then(finished, finished);
	});
}

/**
 * Waits, up to the configured budget, for the attempt a retry names to end.
 * A client reports acceptance when the user clicks, which precedes WHOOP's
 * redirect — so the retry blocks briefly and usually finds the login landed.
 * A name this process never minted waits for nothing and returns at once.
 */
export async function awaitLoginAttempt(
	requestState: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<AwaitedAttempt> {
	const attempt =
		requestState === undefined ? undefined : inFlight.get(requestState);
	if (!attempt) {
		return "no-attempt";
	}

	return (await within(attempt.over, loginWaitMs(env))) ? "over" : "waiting";
}

/** A login in flight, as the surface that offered it describes it. */
export type LoginAttempt = {
	/** The opaque name this attempt travels to the client under. */
	readonly requestState: string;
	/** Where the user's browser has to go to consent. */
	readonly authorizeUrl: URL;
};

/**
 * Result of starting a login: an attempt now holding its port, or the message
 * explaining why none could be offered.
 */
export type StartedLogin =
	| { readonly started: true; readonly attempt: LoginAttempt }
	| { readonly started: false; readonly unavailable: string };

/** The instruction for finishing the login outside the conversation. */
const LOGIN_IN_A_TERMINAL = "run `npx mcp-whoop login` in a terminal";

/**
 * The login command's paste fallback, which needs a terminal and so cannot be
 * offered here.
 */
const PASTE_FALLBACK = `Or ${LOGIN_IN_A_TERMINAL}, which can take the redirect URL pasted out of your browser instead.`;

/** The answer every start receives once shutdown has begun. */
const CLOSING: StartedLogin = {
	started: false,
	unavailable: `This server is shutting down, so no login can be offered here. To log in, ${LOGIN_IN_A_TERMINAL}.`,
};

/**
 * The message for a redirect URI that is not an http:// loopback address. The
 * URI is echoed because it is a registered callback address, not a secret.
 */
function notLoopbackMessage(redirectUri: string): string {
	return loginChecklist({
		problem: "the redirect URI is not an http:// loopback address.",
		items: [`WHOOP_REDIRECT_URI is ${redirectUri}`],
		remedy: `A login offered inside an MCP client catches WHOOP's redirect on a plain-HTTP loopback port of this machine, so only an http:// loopback redirect URI — one on http://127.0.0.1, http://localhost or http://[::1] — can be finished here. Register one in the WHOOP Developer Dashboard (${DEVELOPER_DASHBOARD}) and set it here. ${PASTE_FALLBACK}`,
	});
}

/**
 * The message for a loopback port that could not be bound — held by another
 * process, or not one this user may bind; both refuse the same way.
 */
function portInUseMessage(redirectUri: string): string {
	return loginChecklist({
		problem: "the redirect URI's port is already in use.",
		items: [`WHOOP_REDIRECT_URI is ${redirectUri}`],
		remedy: `A login offered inside an MCP client catches WHOOP's redirect by listening on that port itself, and this machine would not open it: something else is holding it, or it is not a port you may bind. Free it — or register a redirect URI on another port in the WHOOP Developer Dashboard (${DEVELOPER_DASHBOARD}) and set it here — then try again. ${PASTE_FALLBACK}`,
	});
}

/**
 * Resolves the application a login offered here would use, via the shared
 * precedence rule (`src/whoop/auth/application.ts`). An unreadable store
 * resolves as absent rather than failing: it is one of the reasons a login is
 * being offered, and the login rewrites it whole.
 */
async function offeredApplication(
	env: NodeJS.ProcessEnv,
): Promise<ResolvedApplication | undefined> {
	const stored = await readStoredTokens({ env }).catch(() => undefined);

	return resolveApplication(env, stored?.application);
}

/**
 * Returns the store's current attempt, or starts one. The promise is
 * registered before anything is awaited so concurrent calls join it; a start
 * that failed releases its slot so the next call can try again.
 */
export function startLoginAttempt(
	env: NodeJS.ProcessEnv,
): Promise<StartedLogin> {
	if (closing) {
		return Promise.resolve(CLOSING);
	}
	const store = resolveTokenStorePath({ env });
	const already = perStore.get(store);
	if (already) {
		return already;
	}
	const starting = openLoginAttempt(store, env);
	perStore.set(store, starting);
	void starting.then(
		(started) => {
			if (!started.started) {
				release(store, starting);
			}
		},
		() => release(store, starting),
	);

	return starting;
}

/**
 * Starts a login this machine can finish unattended, or reports why it
 * cannot: incomplete application credentials, a non-loopback redirect URI, or
 * an unbindable port. The listener is bound before this returns, so a browser
 * arriving the instant the link does still finds the port open.
 */
async function openLoginAttempt(
	store: string,
	env: NodeJS.ProcessEnv,
): Promise<StartedLogin> {
	const resolved = await offeredApplication(env);
	// The client may have disconnected while the store was read: a listener
	// bound now would outlive the conversation.
	if (closing) {
		return CLOSING;
	}
	// Unlike the login command, there is no terminal to paste a redirect URL
	// into, so the redirect URI is required here.
	if (!resolved?.redirectUri) {
		return {
			started: false,
			unavailable: missingCredentialsMessage(
				missingApplicationVariables(resolved),
				LOGIN_IN_A_TERMINAL,
			),
		};
	}
	const app: WhoopAppCredentials = {
		clientId: resolved.clientId,
		clientSecret: resolved.clientSecret,
		redirectUri: resolved.redirectUri,
	};

	// A malformed WHOOP_REDIRECT_URI only warns at startup under stdio
	// (`src/config/environment.ts`), so an unparseable value can reach here and
	// must read as "no login can be offered", never as a thrown parse failure.
	const redirectUri = URL.parse(app.redirectUri);
	if (!redirectUri || !isLoopbackRedirect(redirectUri)) {
		return {
			started: false,
			unavailable: notLoopbackMessage(app.redirectUri),
		};
	}

	const expectedState = unguessable();
	let capture: LoopbackRedirectCapture;
	try {
		capture = await listenForRedirect({
			redirectUri,
			expectedState,
			complete: (code) => completeLogin(code, app, env),
		});
	} catch {
		return {
			started: false,
			unavailable: portInUseMessage(app.redirectUri),
		};
	}
	// The disconnect may have arrived while the port was being bound, after the
	// drain had nothing of this attempt to end: release the port immediately.
	if (closing) {
		await capture.close();

		return CLOSING;
	}
	const requestState = unguessable();
	// End an attempt nobody completes or refuses, so it cannot hold the port
	// for the life of the process.
	const lifetime = setTimeout(() => {
		log.debug("nobody came back to the WHOOP consent link: ending the attempt");
		void endLoginAttempt(requestState);
	}, loginAttemptLifetimeMs(env));
	// The listener, not the expiry timer, is what keeps the process alive.
	lifetime.unref();
	// An attempt can end without the browser ever answering — declined,
	// expired, or disconnected — and waiters must learn that immediately rather
	// than sit out their budget on a redirect that is no longer coming.
	let ended: () => void = () => {};
	const explicitlyEnded = new Promise<void>((resolve) => {
		ended = resolve;
	});
	const over = Promise.race([
		capture.answered.then(() => endLoginAttempt(requestState)),
		explicitlyEnded,
	]);
	inFlight.set(requestState, {
		store,
		over,
		end: async () => {
			clearTimeout(lifetime);
			await capture.close();
			ended();
		},
	});

	const attempt: LoginAttempt = {
		requestState,
		authorizeUrl: buildAuthorizeUrl({
			env,
			app,
			scopes: ELICITED_SCOPES,
			state: expectedState,
		}),
	};
	log.debug(`waiting for WHOOP to send a browser back to ${app.redirectUri}`);

	return { started: true, attempt };
}

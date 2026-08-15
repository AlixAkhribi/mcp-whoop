import { randomBytes } from "node:crypto";
import { redactSecrets } from "@/lib/redaction";
import { exchangeAuthorizationCode } from "@/whoop/api/oauth/token-exchange";
import {
	type StoredTokens,
	writeStoredTokens,
} from "@/whoop/auth/tokens/store";
import { buildAuthorizeUrl } from "./authorize-url";
import { openInBrowser } from "./browser";
import {
	missingCredentialVariables,
	readCredentials,
	type WhoopAppCredentials,
} from "./credentials";
import {
	listenForRedirect,
	type RedirectCapture,
	type RedirectExpectation,
} from "./redirect-listener";
import { readPastedRedirect } from "./redirect-paste";
import { requestedScopes } from "./requested-scopes";

/** Where a user registers the WHOOP application these credentials come from. */
const DEVELOPER_DASHBOARD = "https://developer-dashboard.whoop.com";

/**
 * The parts of the login command a terminal normally owns. Every one defaults
 * to the real thing; passing explicit ones keeps a run from opening a browser
 * or writing to the console.
 */
type LoginRuntime = {
	/** Environment the application and the store location come from. */
	readonly env?: NodeJS.ProcessEnv;
	/** Where the command's own output goes. */
	readonly print?: (message: string) => void;
	/** Where the command's failures go. */
	readonly printFailure?: (message: string) => void;
	/** Best-effort browser launch. */
	readonly openBrowser?: (url: string) => void;
	/** Where a pasted redirect URL is read from. */
	readonly input?: NodeJS.ReadableStream;
};

/**
 * The message for an incomplete environment. Only the variables actually
 * missing are named, so it reads as a checklist of what is left to do.
 */
function missingCredentialsMessage(missing: readonly string[]): string {
	const subject =
		missing.length === 1
			? "an environment variable is"
			: "environment variables are";

	return [
		`Cannot log in to WHOOP: ${subject} missing.`,
		...missing.map((name) => `  - ${name}`),
		"",
		`Every user brings their own WHOOP application. Register one in the WHOOP Developer Dashboard (${DEVELOPER_DASHBOARD}), then set the variable${missing.length === 1 ? "" : "s"} above from its settings and run this command again.`,
	].join("\n");
}

/** What went wrong, as a user should read it. */
function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A way of getting the authorization code back, plus what the user is told
 * while it waits — the two halves of the login that differ between catching
 * the redirect and being handed it.
 */
type RedirectCaptureStrategy = RedirectCapture & {
	/** What the user is asked to do once the authorize URL is on screen. */
	readonly waiting: readonly string[];
};

/** Whether this machine could open a listener on the redirect URI's own port. */
function isLoopback(redirectUri: URL): boolean {
	const { hostname } = redirectUri;

	return (
		hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname)
	);
}

/**
 * A listener on the redirect URI's own port, or undefined when this machine
 * will not give it to this login: a port another process or another login
 * already holds, or one the user may not bind. Every such failure has the same
 * remedy, so none of them ends the login.
 */
async function openListener(
	expectation: RedirectExpectation,
): Promise<RedirectCapture | undefined> {
	if (!isLoopback(expectation.redirectUri)) {
		return undefined;
	}

	try {
		return await listenForRedirect(expectation);
	} catch {
		return undefined;
	}
}

/**
 * How this login will get the code back. A loopback redirect URI this machine
 * can still bind is caught automatically; anything else is pasted by the user,
 * which is the only way back when the redirect lands where nothing is
 * listening.
 */
async function openCapture({
	app,
	expectedState,
	input,
}: {
	readonly app: WhoopAppCredentials;
	readonly expectedState: string;
	readonly input: NodeJS.ReadableStream;
}): Promise<RedirectCaptureStrategy> {
	const listener = await openListener({
		redirectUri: new URL(app.redirectUri),
		expectedState,
	});

	if (listener) {
		return {
			...listener,
			waiting: [
				`Waiting for WHOOP to send the browser back to ${app.redirectUri}`,
			],
		};
	}

	return {
		...readPastedRedirect({ input, expectedState }),
		waiting: [
			`This machine cannot catch WHOOP's redirect to ${app.redirectUri} itself.`,
			"Paste the full URL your browser ends up on here, then press Enter:",
		],
	};
}

/**
 * Walks the browser consent flow and returns the tokens it ended with. The
 * capture is opened before anything sends the user to WHOOP, so a redirect
 * this machine listens for can never arrive at a closed port.
 */
async function authorize({
	app,
	env,
	print,
	openBrowser,
	input,
}: {
	readonly app: WhoopAppCredentials;
	readonly env: NodeJS.ProcessEnv;
	readonly print: (message: string) => void;
	readonly openBrowser: (url: string) => void;
	readonly input: NodeJS.ReadableStream;
}): Promise<StoredTokens> {
	const scopes = requestedScopes(env);
	const state = randomBytes(32).toString("base64url");
	const authorizeUrl = buildAuthorizeUrl({ env, app, scopes, state });
	const capture = await openCapture({ app, expectedState: state, input });

	try {
		print("Open this URL in your browser to authorize this server with WHOOP:");
		print("");
		print(authorizeUrl.href);
		print("");
		for (const line of capture.waiting) {
			print(line);
		}
		openBrowser(authorizeUrl.href);

		const redirect = await capture.captured;
		if (!redirect.authorized) {
			throw new Error(redirect.failure);
		}

		return await exchangeAuthorizationCode({
			env,
			app,
			code: redirect.code,
			requested: scopes,
		});
	} finally {
		await capture.close();
	}
}

/**
 * Runs the `login` command and reports the exit code it earned. Diagnostics go
 * to stderr and the command's own output to stdout, matching every other
 * command in this package.
 */
export async function runLogin({
	env = process.env,
	print = (message) => {
		console.log(message);
	},
	printFailure = (message) => {
		console.error(message);
	},
	openBrowser = openInBrowser,
	input = process.stdin,
}: LoginRuntime = {}): Promise<number> {
	// Everything this command writes leaves through these two, which scrub the
	// secrets the run has seen: WHOOP error bodies may echo back the code or
	// the client secret, and the tokens a success stores are never printed.
	const say = (message: string): void => {
		print(redactSecrets(message));
	};
	const reportFailure = (message: string): void => {
		printFailure(redactSecrets(message));
	};

	const app = readCredentials(env);
	if (!app) {
		reportFailure(missingCredentialsMessage(missingCredentialVariables(env)));

		return 1;
	}

	try {
		const tokens = await authorize({
			app,
			env,
			print: say,
			openBrowser,
			input,
		});
		// The application is stored with the tokens it earned: the serving
		// process an MCP client spawns has no WHOOP environment of its own, and
		// the refresh grant must authenticate as this same application.
		await writeStoredTokens(
			{
				...tokens,
				application: { clientId: app.clientId, clientSecret: app.clientSecret },
			},
			{ env },
		);

		say("Logged in to WHOOP.");
		say(`Granted scopes: ${tokens.scopes.join(" ")}`);

		return 0;
	} catch (error) {
		reportFailure(
			`Cannot log in to WHOOP: ${describeFailure(error)}\n\nNothing was stored; run the command again to retry.`,
		);

		return 1;
	}
}

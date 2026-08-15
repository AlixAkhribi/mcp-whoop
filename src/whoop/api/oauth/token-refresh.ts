import { log } from "@/lib/log";
import { registerSecrets } from "@/lib/redaction";
import { tokenEndpoint } from "@/whoop/api/client/endpoints";
import {
	classifiedWhoopFailure,
	isRetryableStatus,
	whoopFetch,
} from "@/whoop/api/client/http";
import { OFFLINE_SCOPE } from "@/whoop/auth/tokens/scopes";
import type {
	StoredApplication,
	StoredTokens,
} from "@/whoop/auth/tokens/store";
import {
	oauthErrorSchema,
	parseJson,
	storedTokensFromResponse,
} from "./token-response";

/**
 * WHOOP rejected the refresh token itself, so the login behind it is dead —
 * revoked, rotated away, or expired — and only a fresh `login` restores it.
 * Callers match on this class to say exactly that to the user.
 */
export class InvalidGrantError extends Error {}

/**
 * Shown when nothing can sign the refresh: the store carries no application,
 * and the serving process carries no WHOOP environment because an MCP client
 * spawned it rather than the terminal the login ran in. Both remedies are
 * named because either one unblocks.
 */
const NO_APP_CREDENTIALS =
	"No WHOOP app credentials are available to refresh the login with. Run `npx mcp-whoop login` in a terminal to log in again (the login stores them for refreshes), or set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in the MCP server's environment.";

/**
 * The application this refresh authenticates as: the environment's pair when
 * the serving process carries a whole one, otherwise the pair the login
 * recorded beside the tokens. Explicit configuration wins so that a secret
 * rotated in WHOOP's dashboard reaches a store written before the rotation.
 */
function refreshApplication(
	stored: StoredTokens,
	env: NodeJS.ProcessEnv,
): StoredApplication | undefined {
	const clientId = env.WHOOP_CLIENT_ID?.trim();
	const clientSecret = env.WHOOP_CLIENT_SECRET?.trim();
	if (clientId && clientSecret) {
		return { clientId, clientSecret };
	}

	return stored.application;
}

/**
 * Trades the stored refresh token for a rotated access+refresh pair.
 *
 * WHOOP rotates the refresh token on every use, so the returned pair wholly
 * replaces the one sent. The `offline` scope is requested again because WHOOP
 * requires it on refresh grants to keep issuing refresh tokens. The signing
 * application is stored with the rotation, so the next refresh needs no
 * environment at all.
 *
 * @throws {InvalidGrantError} When WHOOP rejects the refresh token itself, so
 * callers can tell a dead login apart from a failure a retry could get past.
 */
export async function refreshTokens(
	stored: StoredTokens,
	{ env = process.env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<StoredTokens> {
	const application = refreshApplication(stored, env);
	if (!application) {
		throw new Error(NO_APP_CREDENTIALS);
	}
	// The client secret enters the serving process here, from either source.
	registerSecrets(application.clientSecret);

	log.debug("asking WHOOP to refresh the access token");
	const response = await whoopFetch({
		operation: "the token refresh",
		url: tokenEndpoint(env),
		env,
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: stored.refreshToken,
			client_id: application.clientId,
			client_secret: application.clientSecret,
			scope: OFFLINE_SCOPE,
		}),
	});

	const body = await response.text();
	const payload = parseJson(body);
	if (!response.ok) {
		// A rate limit or an outage says nothing about the login itself, so
		// these are classified before the dead-login check looks at the body.
		if (isRetryableStatus(response.status)) {
			throw classifiedWhoopFailure("the token refresh", response, body);
		}
		const failure = oauthErrorSchema.safeParse(payload);
		// Each of these means the stored login cannot continue, whatever OAuth
		// promises. `invalid_grant` is the spec's dead-token answer.
		// `invalid_request` is what WHOOP returns for a revoked or unknown
		// refresh token; this request's shape is fixed, so it can only be the
		// token WHOOP objects to. `invalid_scope` arrives when a scope the
		// login was granted has since been disabled in the app's dashboard,
		// which that token chain can never recover from. One remedy fits all
		// three: log in again.
		const DEAD_LOGIN_ERRORS = [
			"invalid_grant",
			"invalid_request",
			"invalid_scope",
		];
		if (failure.success && DEAD_LOGIN_ERRORS.includes(failure.data.error)) {
			throw new InvalidGrantError("WHOOP no longer accepts the refresh token");
		}
		throw classifiedWhoopFailure("the token refresh", response, body);
	}

	const rotated: StoredTokens = {
		...storedTokensFromResponse(payload, stored.scopes),
		application,
	};
	// Refreshes are rare and load-bearing — a dead login shows up here first —
	// so the success is worth a default-visible line, told only once the 200
	// body has proved to hold tokens: a false success would point a reader
	// away from the real failure.
	log.info("the WHOOP access token was refreshed; a rotated pair replaces it");

	return rotated;
}

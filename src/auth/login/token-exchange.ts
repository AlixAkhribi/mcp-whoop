import { tokenEndpoint } from "@/api/client/endpoints";
import {
	oauthErrorSchema,
	parseJson,
	storedTokensFromResponse,
} from "@/api/oauth/token-response";
import type { StoredTokens } from "@/auth/tokens/store";
import { registerSecrets } from "@/lib/redaction";
import type { WhoopAppCredentials } from "./environment";

/**
 * A rejected exchange, phrased so the user can act on it. WHOOP's own OAuth
 * error is the whole diagnosis — an expired code, a redirect URI that does not
 * match what was registered — so it is passed through rather than summarised.
 */
function rejection(status: number, payload: unknown): string {
	const failure = oauthErrorSchema.safeParse(payload);
	if (!failure.success) {
		return `the token exchange failed (HTTP ${status})`;
	}

	const { error, error_description: description } = failure.data;

	return `the token exchange failed (${error}${description ? `: ${description}` : ""})`;
}

/** What the login command has to hand to trade a code for tokens. */
export type CodeExchange = {
	/** Environment the endpoint is resolved from. */
	readonly env: NodeJS.ProcessEnv;
	/** The application the code was issued to. */
	readonly app: WhoopAppCredentials;
	/** The authorization code the browser came back with. */
	readonly code: string;
	/**
	 * The scopes that were asked for. WHOOP is not documented to name the
	 * granted set in its answer, so the asked-for set stands in when it does
	 * not; consent WHOOP narrowed silently would be indistinguishable anyway.
	 */
	readonly requested: readonly string[];
};

/**
 * Trades an authorization code for tokens. WHOOP takes the application's
 * credentials in the form body, which keeps the secret out of the request line.
 */
export async function exchangeAuthorizationCode({
	env,
	app,
	code,
	requested,
}: CodeExchange): Promise<StoredTokens> {
	// The code is a single-use credential until this exchange spends it, and a
	// rejected exchange is exactly when WHOOP's error body may echo it back.
	registerSecrets(code);

	const response = await fetch(tokenEndpoint(env), {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: app.clientId,
			client_secret: app.clientSecret,
			redirect_uri: app.redirectUri,
		}),
	});

	const payload = parseJson(await response.text());
	if (!response.ok) {
		throw new Error(rejection(response.status, payload));
	}

	return storedTokensFromResponse(payload, requested);
}

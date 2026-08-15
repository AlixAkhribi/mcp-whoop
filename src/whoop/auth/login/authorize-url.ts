import { authorizeEndpoint } from "@/whoop/api/client/endpoints";
import type { WhoopAppCredentials } from "./credentials";

/** What the authorize URL is assembled from. */
type AuthorizationRequest = {
	/** Environment the endpoint is resolved from. */
	readonly env: NodeJS.ProcessEnv;
	/** The application asking for consent. */
	readonly app: WhoopAppCredentials;
	/** The scopes being asked for. */
	readonly scopes: readonly string[];
	/** The anti-forgery value the redirect has to come back with. */
	readonly state: string;
};

/**
 * The URL the user's browser goes to in order to consent. The redirect URI is
 * sent exactly as the environment spells it: WHOOP matches it character for
 * character against the one registered for the application.
 */
export function buildAuthorizeUrl({
	env,
	app,
	scopes,
	state,
}: AuthorizationRequest): URL {
	const url = authorizeEndpoint(env);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("redirect_uri", app.redirectUri);
	url.searchParams.set("scope", scopes.join(" "));
	url.searchParams.set("state", state);

	return url;
}

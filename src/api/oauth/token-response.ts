import { z } from "zod";

import type { StoredTokens } from "@/auth/tokens/store";
import { registerSecrets } from "@/lib/redaction";

/** The part of WHOOP's token response this server acts on. */
const tokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
	scope: z.string().optional(),
});

/** The OAuth 2.0 error shape a failed token request comes back with. */
export const oauthErrorSchema = z.object({
	error: z.string(),
	error_description: z.string().optional(),
});

/** The body as JSON, or undefined when it is not JSON. */
export function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

/**
 * Converts a successful token response into stored form, shared by both grants
 * that end in tokens: an authorization code and a refresh.
 *
 * WHOOP is not documented to always name the granted scopes, so
 * `fallbackScopes` stands in when it does not — the requested set for a first
 * exchange, the already-stored set for a refresh.
 */
export function storedTokensFromResponse(
	payload: unknown,
	fallbackScopes: readonly string[],
): StoredTokens {
	const parsed = tokenResponseSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error("the token endpoint answered with an unexpected body");
	}
	// Fresh token material enters the process here, on a first exchange and on
	// every rotation alike.
	registerSecrets(parsed.data.access_token, parsed.data.refresh_token);

	const granted = (parsed.data.scope ?? "").split(/\s+/).filter(Boolean);

	return {
		accessToken: parsed.data.access_token,
		refreshToken: parsed.data.refresh_token,
		expiresAt: Date.now() + parsed.data.expires_in * 1000,
		scopes: granted.length > 0 ? granted : [...fallbackScopes],
	};
}

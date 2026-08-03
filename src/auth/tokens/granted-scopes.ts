import { readStoredTokens, type TokenStoreLocation } from "./store";

/**
 * The scopes the stored login was granted, read fresh from the token store.
 * No store and an unreadable store both report `undefined`: neither records a
 * grant to narrow the tool surface by, and the tools themselves turn either
 * state into an actionable login error when called.
 */
export async function grantedScopes(
	location: TokenStoreLocation = {},
): Promise<readonly string[] | undefined> {
	try {
		return (await readStoredTokens(location))?.scopes;
	} catch {
		return undefined;
	}
}

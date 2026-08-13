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

/**
 * Whether a grant allows something this server would only offer if it could
 * answer it: every one of `required` has to be in it, never merely one — half
 * of what an answer is assembled from would buy a tool or a resource that fails
 * on the read it was not allowed to make.
 *
 * `undefined` — no recorded grant — allows everything, so the surface a user
 * meets before their first login is the whole of it rather than nothing at all;
 * what they reach for then names the login command itself.
 *
 * One predicate for both surfaces: the tools a model picks from and the
 * resources a user attaches are shaped by the same grant, and two copies of
 * this rule would be two things to keep in agreement.
 */
export function grantAllows(
	granted: readonly string[] | undefined,
	...required: string[]
): boolean {
	return (
		granted === undefined || required.every((scope) => granted.includes(scope))
	);
}

/**
 * Insists the grant an answer is about to be read under allows it, naming what
 * is missing and the command that fixes it when it does not.
 *
 * This is the gate that runs when a tool is called or a resource is read — on
 * the grant as the store holds it at that moment, not as it stood when the
 * serving process started — so a login redone mid-connection is judged by what
 * it granted, and a scope it dropped refuses with the way back instead of
 * relaying whatever WHOOP would answer a request it never permitted.
 *
 * @throws When the grant is recorded and lacks any of `required`.
 */
export function requireGrant(
	granted: readonly string[] | undefined,
	...required: string[]
): void {
	if (grantAllows(granted, ...required)) {
		return;
	}
	const missing = required.filter((scope) => !granted?.includes(scope));
	throw new Error(
		`The stored WHOOP login was not granted ${missing.join(", ")}, which this answer is read with. Run \`npx mcp-whoop login\` in a terminal to log in again, then try again.`,
	);
}

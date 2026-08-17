import { WhoopUnauthorizedError } from "@/whoop/api/client/errors";
import {
	InvalidGrantError,
	refreshTokens,
} from "@/whoop/api/oauth/token-refresh";
import { requireGrant } from "./granted-scopes";
import { withStoreLock } from "./lock";
import {
	readStoredTokens,
	type StoredTokens,
	writeStoredTokens,
} from "./store";
import { LoginRequiredError, requireStoredLogin } from "./stored-login";

/**
 * Shown when WHOOP rejects the refresh token itself and no consent screen can
 * be offered: the stored login is dead — revoked, or idle past WHOOP's limit
 * — and the out-of-band login command is then the only way back.
 */
const LOGIN_NO_LONGER_VALID =
	"The stored WHOOP login is no longer valid. Run `npx mcp-whoop login` in a terminal to log in again, then try again.";

/**
 * The store as it stands right now, or `fallback` when it cannot be read. A
 * store deleted or corrupted mid-flight changes nothing about the tokens this
 * process already holds.
 */
async function storedTokensNow(
	fallback: StoredTokens,
	env: NodeJS.ProcessEnv,
): Promise<StoredTokens> {
	const current = await readStoredTokens({ env }).catch(() => undefined);

	return current ?? fallback;
}

/**
 * Refreshes and persists in one move, under the store's exclusive lock.
 *
 * WHOOP refresh tokens are single-use while every MCP client spawns its own
 * server process against one store, so an unguarded race burns the token for
 * everyone but the winner. The lock re-reads the store on entry: whoever held
 * it first has usually rotated already, and those tokens are adopted instead of
 * spending a refresh WHOOP would reject.
 *
 * @throws {LoginRequiredError} When WHOOP rejects the refresh token and no
 * newer rotation is on disk — the same class as a login that never happened,
 * so a client that can be shown WHOOP's consent screen is offered one instead
 * of {@link LOGIN_NO_LONGER_VALID}.
 */
async function refreshAndPersist(
	stored: StoredTokens,
	env: NodeJS.ProcessEnv,
): Promise<StoredTokens> {
	return withStoreLock({ env }, async () => {
		// Refresh tokens rotate on every use, so a store naming a different one
		// was refreshed by another process while this one waited: that rotation
		// is the live login, and refreshing over it would kill it.
		const current = await storedTokensNow(stored, env);
		if (current.refreshToken !== stored.refreshToken) {
			return current;
		}

		let rotated: StoredTokens;
		try {
			rotated = await refreshTokens(current, { env });
		} catch (error) {
			if (!(error instanceof InvalidGrantError)) {
				throw error;
			}
			// "Already spent" can also mean spent by a process whose lock was
			// taken over mid-refresh, so one re-read separates a rotation that
			// landed meanwhile from a login that is truly dead. Nothing newer on
			// that single look means dead; further retries would not change it.
			const adopted = await storedTokensNow(current, env);
			if (adopted.refreshToken !== current.refreshToken) {
				return adopted;
			}
			throw new LoginRequiredError(LOGIN_NO_LONGER_VALID);
		}
		await writeStoredTokens(rotated, { env });

		return rotated;
	});
}

/**
 * Runs an authorized WHOOP call with an access token that is not known to be
 * expired, refreshing a stored token past its recorded expiry first so no
 * request goes out with credentials the store already says are dead.
 *
 * A token the store still trusts but WHOOP answers 401 to — revoked, or expired
 * by a clock this server cannot see — buys exactly one refresh and retry. A
 * second 401 propagates, since another refresh would only loop.
 *
 * The refresh path deliberately takes no cancellation signal: WHOOP refresh
 * tokens are single-use, so an abort landing after WHOOP consumed one but
 * before the rotation reached the store would kill the login for every process
 * sharing it. A refresh that has started must land; only the data reads around
 * it are abandonable.
 */
export async function withValidAccessToken<T>(
	stored: StoredTokens,
	use: (accessToken: string) => Promise<T>,
	{ env = process.env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
	let tokens = stored;
	if (tokens.expiresAt <= Date.now()) {
		tokens = await refreshAndPersist(tokens, env);
	}

	try {
		return await use(tokens.accessToken);
	} catch (error) {
		if (!(error instanceof WhoopUnauthorizedError)) {
			throw error;
		}
		tokens = await refreshAndPersist(tokens, env);

		return use(tokens.accessToken);
	}
}

type AuthorizedWhoopAccess = {
	readonly accessToken: string;
	readonly signal?: AbortSignal;
};

/**
 * Reads the current login, enforces its current grant, and supplies a valid
 * access token. Registration-time narrowing remains an advertised-surface
 * optimization; this is the per-call authorization boundary.
 */
export async function withAuthorizedWhoopAccess<T>(
	requiredScopes: readonly string[],
	operation: (access: AuthorizedWhoopAccess) => Promise<T>,
	{
		env = process.env,
		signal,
	}: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<T> {
	const tokens = await requireStoredLogin({ env });
	requireGrant(tokens.scopes, ...requiredScopes);

	return withValidAccessToken(
		tokens,
		(accessToken) => operation({ accessToken, signal }),
		{ env },
	);
}

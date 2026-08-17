import {
	readStoredTokens,
	type StoredTokens,
	type TokenStoreLocation,
} from "./store";

/**
 * No usable login stands behind the call — none was recorded, or WHOOP has
 * stopped honouring it. Its own class so the one failure a client can be
 * walked out of — by being shown WHOOP's consent screen — is distinguishable
 * from every other way a read can fail; the message stays the prose a client
 * without that support still reads.
 */
export class LoginRequiredError extends Error {}

/**
 * Shown when the server has never been logged in and no consent screen can be
 * offered. Names the out-of-band login command, then the only way out.
 */
const NOT_LOGGED_IN =
	"Not connected to WHOOP. Run `npx mcp-whoop login` in a terminal to authorize this server, then try again.";

/**
 * Shown when a store exists but cannot be trusted — corrupt, unreadable, or not
 * holding tokens at all. The remedy is the same command a first login uses,
 * since it rewrites the store whole.
 */
const STORE_UNREADABLE =
	"The stored WHOOP login could not be read. Run `npx mcp-whoop login` in a terminal to log in again, then try again.";

/**
 * The stored login every read of WHOOP data starts from — whichever surface
 * asked, a tool or a resource — read fresh per call.
 *
 * @throws When no store exists or it cannot be trusted, carrying the message
 * that names the login command — the shared failure mode of everything this
 * server serves.
 */
export async function requireStoredLogin(
	location: TokenStoreLocation = {},
): Promise<StoredTokens> {
	const tokens = await readStoredTokens(location).catch(() => {
		throw new LoginRequiredError(STORE_UNREADABLE);
	});
	if (!tokens) {
		throw new LoginRequiredError(NOT_LOGGED_IN);
	}

	return tokens;
}

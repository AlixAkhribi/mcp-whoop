import { readStoredTokens, type StoredTokens } from "./store";

/**
 * Shown when the server has never been logged in. It names the out-of-band
 * login command because that is the only way out: an MCP client cannot drive
 * WHOOP's browser consent for the user.
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
export async function requireStoredLogin(): Promise<StoredTokens> {
	const tokens = await readStoredTokens().catch(() => {
		throw new Error(STORE_UNREADABLE);
	});
	if (!tokens) {
		throw new Error(NOT_LOGGED_IN);
	}

	return tokens;
}

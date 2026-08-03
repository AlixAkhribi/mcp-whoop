# mcp-whoop

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [WHOOP](https://www.whoop.com), served over stdio.

Published on npm as [`mcp-whoop`](https://www.npmjs.com/package/mcp-whoop).

> **Status: pre-1.0.** The authentication surface is complete — browser login, automatic token refresh, scope-gated tools, and logout, against WHOOP's v2 API — serving profile and body measurements so far; the wider read surface is still landing. The server speaks the current MCP spec revision (2026-07-28) via SDK v2.

## Usage

Run directly with `npx` (Node.js `^22.22.1 || >=24.10.0`):

```sh
npx mcp-whoop
```

### Logging in

Every user brings their own WHOOP application: register one in the [WHOOP Developer Dashboard](https://developer-dashboard.whoop.com), give it a loopback redirect URI (for example `http://127.0.0.1:8788/callback`), then run the login once in a terminal:

```sh
WHOOP_CLIENT_ID=… WHOOP_CLIENT_SECRET=… WHOOP_REDIRECT_URI=… npx mcp-whoop login
```

It prints an authorization URL, opens it in your browser, captures the redirect, and saves the resulting tokens — together with the app credentials, which WHOOP requires again on every token refresh — in your platform's per-user data directory, readable only by you. From then on the server refreshes the rotating tokens by itself; you log in again only if WHOOP stops honoring the stored refresh token. Two optional variables adjust the login: `WHOOP_SCOPES` narrows what is asked for (all six read scopes by default), and `WHOOP_TOKEN_STORE` moves the token file elsewhere. Narrowing is required when your app has fewer scopes enabled in the dashboard: WHOOP refuses an authorization asking for any scope the app may not request — naming the scope in the refusal — rather than consenting to less.

Or add it to an MCP client's configuration — no environment variables needed, the stored login carries everything a refresh requires (setting `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` here overrides the stored pair, for example after rotating the secret in the dashboard):

```json
{
	"mcpServers": {
		"whoop": {
			"command": "npx",
			"args": ["mcp-whoop"]
		}
	}
}
```

### Tools

The login records which scopes WHOOP granted, and the granted set is authoritative for the server's shape: only tools whose scope was granted are served, so a connected model never sees a tool WHOOP would deny. All six read scopes are requested by default; set `WHOOP_SCOPES` at login to ask for less.

| Scope | Tools |
| --- | --- |
| `read:profile` | `get_profile` — the logged-in user's basic profile |
| `read:body_measurement` | `get_body_measurements` — height, weight, max heart rate |

Tools for the remaining read scopes are still landing; their grants are already recorded and will shape the surface the same way.

The `offline` scope is always requested on top: it is what makes WHOOP issue the refresh token that keeps a login alive between sessions.

### Logging out

```sh
npx mcp-whoop logout
```

Revokes this server's access with WHOOP and deletes the stored login. After that, every tool refuses until `login` is run again.

## Development

```sh
pnpm install
pnpm test         # builds dist/ and runs the suite against the built artifact
pnpm inspect      # MCP Inspector (web UI) against the TypeScript source
pnpm inspect:cli  # MCP Inspector (CLI) against the TypeScript source
```

Quality gates (typecheck, Biome, tests, commit convention) run from git hooks locally and again in CI; see `.github/workflows/`. Releases are cut automatically by semantic-release when Conventional Commits merge to `main` — nobody bumps a version by hand.

## License

[MIT](LICENSE)

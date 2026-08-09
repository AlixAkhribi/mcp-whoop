# mcp-whoop

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [WHOOP](https://www.whoop.com), served over stdio.

Published on npm as [`mcp-whoop`](https://www.npmjs.com/package/mcp-whoop).

> **Status: pre-1.0.** The authentication surface is complete — browser login, automatic token refresh, scope-gated tools, and logout, against WHOOP's v2 API — and every read scope WHOOP defines now carries tools: profile and body measurements, the cycle, sleep, recovery and workout reads, and the summaries over them. The server speaks the current MCP spec revision (2026-07-28) via SDK v2.

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

It prints an authorization URL, opens it in your browser, captures the redirect, and saves the resulting tokens — together with the app credentials, which WHOOP requires again on every token refresh — in your platform's per-user data directory, readable only by you (by file mode on POSIX; by your user profile's ACLs on Windows, where Node cannot set one). From then on the server refreshes the rotating tokens by itself; you log in again only if WHOOP stops honoring the stored refresh token. Two optional variables adjust the login: `WHOOP_SCOPES` narrows what is asked for (all six read scopes by default), and `WHOOP_TOKEN_STORE` moves the token file elsewhere. Narrowing is required when your app has fewer scopes enabled in the dashboard: WHOOP refuses an authorization asking for any scope the app may not request — naming the scope in the refusal — rather than consenting to less.

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

Two further variables exist for tests and local development rather than everyday use: `WHOOP_HTTP_TIMEOUT_MS` moves the thirty-second bound every WHOOP request is given, and `WHOOP_API_BASE_URL` points the client at an origin other than WHOOP's own. Every `WHOOP_*` variable is validated at startup: none is required, but a value that does not parse — a timeout that is not a whole number of milliseconds Node's timers can honor, a URL that is not an origin, a scope this server cannot ask WHOOP for — stops the process with a checklist naming what to fix, and a `WHOOP_*` name the server does not read is called out on stderr as a likely typo.

### Tools

The login records which scopes WHOOP granted, and the granted set is authoritative for the server's shape: only tools whose scope was granted are served, so a connected model never sees a tool WHOOP would deny. All six read scopes are requested by default; set `WHOOP_SCOPES` at login to ask for less.

Nothing here writes. Every registration carries MCP's `readOnlyHint`, and every scope asked for is a read scope, so a model reaching this server can read your WHOOP data but has no tool that could change it; `openWorldHint` rides alongside to say that what a tool returns comes from WHOOP over the network rather than from this process.

| Scope | Tools |
| --- | --- |
| `read:profile` | `get_profile` — the logged-in user's basic profile |
| `read:body_measurement` | `get_body_measurements` — height, weight, max heart rate |
| `read:cycles` | `list_cycles` — physiological cycles, newest first, one page at a time<br>`get_cycle` — one physiological cycle by its id |
| `read:sleep` | `list_sleeps` — sleeps and naps, newest first, one page at a time<br>`get_sleep` — one sleep or nap by its id<br>`get_cycle_sleep` — the sleep that started one cycle, by the cycle's id<br>`get_sleep_summary` — the last N nights digested (default 7, max 30), naps counted apart |
| `read:recovery` | `list_recoveries` — recoveries, newest first, one page at a time<br>`get_cycle_recovery` — the recovery scored for one cycle, by the cycle's id |
| `read:workout` | `list_workouts` — workouts, newest first, one page at a time<br>`get_workout` — one workout by its id |
| `read:cycles` + `read:recovery` | `get_recovery_summary` — the last N days digested (default 7, max 30), one row per cycle-day |
| `read:cycles` + `read:recovery` + `read:sleep` | `get_today_snapshot` — how you are today: the cycle running now with its strain so far, its recovery, and the sleep that started it |

Every read scope WHOOP defines now carries a tool here; anything that lands later is gated on its own grant the same way. A tool reading more than one WHOOP surface is served only when every one of its scopes was granted — a partial grant would only buy a tool that fails on the read it is not allowed to make.

The `offline` scope is always requested on top: it is what makes WHOOP issue the refresh token that keeps a login alive between sessions.

### Data tools

Twelve of the fourteen tools above read WHOOP data: nine that map one WHOOP endpoint each, and three that answer a physiological question across many records at once. The other two — `get_profile` and `get_body_measurements` — are the identity pair the login walkthrough already covers.

#### Mapping tools

A mapping tool relays exactly one WHOOP request. Its arguments are WHOOP's own, spelled the way WHOOP's documentation spells them, and its answer is WHOOP's own record, so the arguments a model reads in [WHOOP's API documentation](https://developer.whoop.com/api) are the arguments the tool takes. The four listings share WHOOP's query — `start` and `end` (ISO 8601 instants with an offset), `limit` (1–25, default 10), and `nextToken` — and run newest first, one WHOOP page at a time: each page carries WHOOP's `next_token`, and handing that value back as `nextToken` fetches the page after it. A `next_token` of `null` means there is no page after this one. The relay is the whole story of pagination here: the token is passed through in both directions, and nothing walks the chain on your behalf.

| Tool | Arguments | Reads |
| --- | --- | --- |
| `list_cycles` | `start`, `end`, `limit`, `nextToken` | Physiological cycles |
| `get_cycle` | `cycleId` | One physiological cycle by its id |
| `list_sleeps` | `start`, `end`, `limit`, `nextToken` | Sleeps, with naps among them marked `nap: true` |
| `get_sleep` | `sleepId` | One sleep or nap by its id (a v2 UUID) |
| `get_cycle_sleep` | `cycleId` | The sleep that started one cycle |
| `list_recoveries` | `start`, `end`, `limit`, `nextToken` | Recoveries, each keyed by the cycle it scores |
| `get_cycle_recovery` | `cycleId` | The recovery scored for one cycle |
| `list_workouts` | `start`, `end`, `limit`, `nextToken` | Workouts, each naming the sport WHOOP recognised |
| `get_workout` | `workoutId` | One workout by its id (a v2 UUID) |

#### Summary tools

A summary tool answers a question a model would otherwise assemble by hand from several pages: it reads however many records the question spans and digests them server-side into one fixed shape. Its range is a count of the most recent days — `days`, an integer from 1 to 30, 7 by default — never a pair of instants; the bounds are part of the advertised schema, so a call outside them is refused before anything is asked of WHOOP, and arbitrary historical windows belong to the mapping tools above. A day here is one WHOOP physiological cycle — wake to wake, labeled by the cycle's start in the user's own timezone — never a calendar date, and "today" is the cycle running now, which WHOOP scores while it is still being lived.

| Tool | Arguments | Answers |
| --- | --- | --- |
| `get_sleep_summary` | `days` (1–30, default 7) | "How have I been sleeping?" — the last N nights digested: how many WHOOP holds and has scored, the mean, low and high of sleep performance, time in bed and efficiency, the sleep stages beneath them, and one row per night. Naps are counted apart and never averaged into the nightly figures |
| `get_recovery_summary` | `days` (1–30, default 7) | "How has my recovery been?" — the last N cycle-days digested: how many WHOOP holds and has scored, the mean, low and high of recovery score, heart rate variability and resting heart rate, and one row per day |
| `get_today_snapshot` | none | "How am I today?" — the cycle running now with the strain accumulated in it so far, the recovery scored for it, and the sleep that started it. A recovery WHOOP has not scored yet, or a sleep it has no record of, is reported as a state of the day rather than as an error |

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

Login credentials for local development can live in a `.env` file: copy `.env.example`, fill it in (`.env` is git-ignored), and let Node load it natively — `node --env-file=.env dist/index.js login`. No dotenv is involved: under `stdio`, stdout is the protocol wire, and dotenv greets it with a banner by default.

Quality gates (typecheck, Biome, tests, commit convention) run from git hooks locally and again in CI; see `.github/workflows/`. Releases are cut automatically by semantic-release when Conventional Commits merge to `main` — nobody bumps a version by hand.

## License

[MIT](LICENSE)

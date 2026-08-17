# mcp-whoop

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[WHOOP](https://www.whoop.com), served over stdio.

Published on npm as [`mcp-whoop`](https://www.npmjs.com/package/mcp-whoop).

> **Status: pre-1.0.** The authentication surface is complete — browser login,
> automatic token refresh, scope-gated tools, and logout, against WHOOP's v2 API —
> and every read scope WHOOP defines now carries tools: profile and body
> measurements, the cycle, sleep, recovery and workout reads, and the summaries
> over them. The server speaks the current MCP spec revision (2026-07-28) via SDK
> v2.

## Usage

Run directly with `npx` (Node.js `^22.22.1 || >=24.10.0`):

```sh
npx mcp-whoop
```

### Logging in

Every user brings their own WHOOP application. Register one in the
[WHOOP Developer Dashboard](https://developer-dashboard.whoop.com), give it a
loopback redirect URI (for example `http://127.0.0.1:8788/callback`), then run the
login once in a terminal.

POSIX shells:

```sh
WHOOP_CLIENT_ID=… WHOOP_CLIENT_SECRET=… WHOOP_REDIRECT_URI=… npx mcp-whoop login
```

PowerShell:

```powershell
$env:WHOOP_CLIENT_ID = "…"
$env:WHOOP_CLIENT_SECRET = "…"
$env:WHOOP_REDIRECT_URI = "http://127.0.0.1:8788/callback"
npx mcp-whoop login
```

It prints an authorization URL, opens it in your browser, captures the redirect,
and saves the resulting tokens — together with the app credentials, which WHOOP
requires again on every token refresh — in your platform's per-user data
directory. That directory is readable only by you: by file mode on POSIX, and by
your user profile's ACLs on Windows, where Node cannot set one.

From then on the server refreshes the rotating tokens by itself; you log in again
only if WHOOP stops honoring the stored refresh token. Two optional variables
adjust the login: `WHOOP_SCOPES` narrows what is asked for (all six read scopes by
default), and `WHOOP_TOKEN_STORE` moves the token file elsewhere. Narrowing is
required when your app has fewer scopes enabled in the dashboard: WHOOP refuses
an authorization asking for any scope the app may not request — naming the scope
in the refusal — rather than consenting to less.

Or add it to an MCP client's configuration. No environment variables are needed:
the stored login carries everything a refresh requires. Setting
`WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` here overrides the stored pair, for
example after rotating the secret in the dashboard.

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["--yes", "mcp-whoop"]
    }
  }
}
```

Two further variables exist for tests and local development rather than everyday
use. `WHOOP_HTTP_TIMEOUT_MS` moves the thirty-second bound every WHOOP request is
given, and `WHOOP_API_BASE_URL` points the client at an origin other than WHOOP's
own.

Two more bound the login this server offers inside a conversation, when a tool
call finds none stored. `WHOOP_LOGIN_WAIT_MS` is how long such a call waits for
WHOOP to send the browser back before answering "still going" and letting the
client come round again — 2000 ms, two seconds, by default. `WHOOP_LOGIN_TTL_MS`
is how long an offer nobody ever answers keeps the loopback port it borrowed to
catch that redirect: 600000 ms, ten minutes, after which the port goes back to
the machine and the next call offers a fresh link.

Every `WHOOP_*` variable is validated at startup against what the command being
run actually reads. None is required, but a value that does not parse — a timeout
that is not a whole number of milliseconds Node's timers can honor, a URL that is
not an origin, or a scope this server cannot ask WHOOP for — stops that command
with a checklist naming what to fix. `WHOOP_SCOPES` is read by `login` alone, so
a mistake in it refuses `login` but only warns under `stdio` and `logout`.
`WHOOP_REDIRECT_URI` is read by serving too — it is the address WHOOP sends the
browser back to when the server offers you a login inside a conversation, which
it catches on this machine — but a mistake in it warns there rather than
refusing: it costs that offer, not the server. Serving is never taken down by a
value it can carry on without, which matters when the MCP host that spawned it
reports an exit as a failed server and every tool disappears. A `WHOOP_*` name
the server does not read at all is called out on stderr as a likely typo.

Diagnostics go to stderr, never stdout. Under `stdio`, stdout is the JSON-RPC
wire, and stderr is the stream the MCP stdio transport reserves for logging. MCP
hosts capture the stream into their own log files. `WHOOP_LOG_LEVEL` sets how much
lands there — `debug`, `info` (the default), `warning`, or `error` — and every line
is scrubbed of token material before it is written.

### Tools

The login records which scopes WHOOP granted, and the granted set is authoritative
for the server's shape: only tools whose scope was granted are served, so a
connected model never sees a tool WHOOP would deny. All six read scopes are
requested by default; set `WHOOP_SCOPES` at login to ask for less.

Nothing here writes. Every registration carries MCP's `readOnlyHint`, and every
scope asked for is a read scope, so a model reaching this server can read your
WHOOP data but has no tool that could change it. `openWorldHint` rides alongside
to say that what a tool returns comes from WHOOP over the network rather than from
this process.

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

Every read scope WHOOP defines now carries a tool here; anything that lands later
is gated on its own grant the same way. A tool reading more than one WHOOP surface
is served only when every one of its scopes was granted — a partial grant would
only buy a tool that fails on the read it is not allowed to make.

The `offline` scope is always requested on top: it is what makes WHOOP issue the
refresh token that keeps a login alive between sessions.

### Data tools

The mapping and summary tools below read WHOOP data beyond the identity pair,
`get_profile` and `get_body_measurements`, covered in the login walkthrough.

#### Mapping tools

A mapping tool relays exactly one WHOOP request. Its arguments are WHOOP's own,
spelled the way WHOOP's documentation spells them, and its answer is WHOOP's own
record. The arguments a model reads in
[WHOOP's API documentation](https://developer.whoop.com/api) are the arguments
the tool takes.

The listings share WHOOP's query: `start` and `end` (ISO 8601 instants with an
offset), `limit` (1–25, default 10), and `nextToken`. They run newest first, one
WHOOP page at a time. Each page carries WHOOP's `next_token`, and handing that
value back as `nextToken` fetches the page after it. A `next_token` of `null` means
there is no page after this one. The relay is the whole story of pagination here:
the token is passed through in both directions, and nothing walks the chain on
your behalf.

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

A summary tool answers a question a model would otherwise assemble by hand from
several pages. It reads however many records the question spans and digests them
server-side into one fixed shape. Its range is a count of the most recent days —
`days`, an integer from 1 to 30, 7 by default — never a pair of instants. The
bounds are part of the advertised schema, so a call outside them is refused
before anything is asked of WHOOP; arbitrary historical windows belong to the
mapping tools above.

A day here is one WHOOP physiological cycle — wake to wake, labeled by the
cycle's start in the user's own timezone — never a calendar date. "Today" is the
cycle running now, which WHOOP scores while it is still being lived.

| Tool | Arguments | Answers |
| --- | --- | --- |
| `get_sleep_summary` | `days` (1–30, default 7) | "How have I been sleeping?" — the last N nights digested: how many WHOOP holds and has scored, the mean, low and high of sleep performance, time in bed and efficiency, the sleep stages beneath them, and one row per night. Naps are counted apart and never averaged into the nightly figures |
| `get_recovery_summary` | `days` (1–30, default 7) | "How has my recovery been?" — the last N cycle-days digested: how many WHOOP holds and has scored, the mean, low and high of recovery score, heart rate variability and resting heart rate, and one row per day |
| `get_today_snapshot` | none | "How am I today?" — the cycle running now with the strain accumulated in it so far, the recovery scored for it, and the sleep that started it. A recovery WHOOP has not scored yet, or a sleep it has no record of, is reported as a state of the day rather than as an error |

### Resources

Beside the tools, the server serves a curated set of WHOOP resources that a user
can attach to a conversation. A tool is what the model reaches for on its own; a
resource is selected by the user. Each resource answers with the same JSON as its
tool counterpart, and none takes arguments: the span it covers is encoded in its
URI.

| Resource | Answers | Scopes |
| --- | --- | --- |
| `whoop://today` | "How am I today?" — the cycle running now with the strain accumulated in it so far, the recovery scored for it, and the sleep that started it | `read:cycles` + `read:recovery` + `read:sleep` |
| `whoop://profile` | "Who is this server logged in as?" — the account's name, email address and WHOOP user id | `read:profile` |
| `whoop://body-measurements` | "What body are these numbers scored against?" — height, weight, max heart rate | `read:body_measurement` |
| `whoop://recovery/last-week` | "How has my recovery been?" — the last seven cycle-days of recovery digested, one row per day | `read:cycles` + `read:recovery` |
| `whoop://sleep/last-week` | "How have I been sleeping?" — the last seven nights digested, naps counted apart, one row per night | `read:sleep` |

The resource list is identical whatever the login was granted. The MCP revision
this server speaks (2026-07-28) does not allow `resources/list` to vary with
connection state, and a re-login can rewrite the recorded grant while a client
stays connected. Granted scopes gate each read against the store as it
stands when the read runs. A refused read names the missing scopes and the login
command that fixes them.

Every entry is a snapshot, not a stream: a read answers with the numbers WHOOP
holds at that moment, and the client re-reads the URI whenever it wants fresher
ones. The server never pushes updates — it accepts no subscription and sends no
change notification, so nothing already attached to a conversation changes
underneath it.

Every read also answers with a zero reuse lifetime (`ttlMs: 0`, the revision's
"immediately stale"). Each answer is bound to whoever the stored login belongs
to, and a re-login can hand the store to a different WHOOP account without
anything an MCP client can observe changing. Rather than promise a freshness it
cannot stand behind, the server tells clients to re-read every time. The listing
itself is the part that holds still, and it alone carries an hour's lifetime.

To browse the surface yourself, point the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) at the
TypeScript source. It spawns this server over stdio exactly as an MCP host does,
and the stored login carries everything the spawned process needs:

```sh
pnpm inspect                                                  # web UI
pnpm inspect:cli --method resources/list                      # list resources
pnpm inspect:cli --method resources/read --uri whoop://today  # one of them, read
```

In the web UI, connect, open the **Resources** tab and press **List Resources**.
The entries in the table above come back with the title and description a
client's picker shows a person. Select one and the JSON a read answers with fills
the pane beside the list; select it again for a fresher copy. A second read is the
whole freshness story, since nothing arrives unasked.

The CLI answers the same two questions without a browser, which is the quickest
way to check what a narrowed login is refused. `resources/list` prints the
listing, and `resources/read` prints one resource's JSON for the `--uri` you name
— or, for a scope the login was not granted, the refusal that names it.

### Logging out

```sh
npx mcp-whoop logout
```

Revokes this server's access with WHOOP and deletes the stored login. After that,
every tool refuses until `login` is run again.

## Development

```sh
pnpm install
pnpm test         # builds dist/ and runs the default suite
pnpm test:package # packs and installs the tarball; may access the npm registry
pnpm inspect      # MCP Inspector (web UI) against the TypeScript source
pnpm inspect:cli  # MCP Inspector (CLI) against the TypeScript source
```

Login credentials for local development can live in a `.env` file: copy
`.env.example`, fill it in (`.env` is git-ignored), and let Node load it natively
— `node --env-file=.env dist/index.js login`. No dotenv is involved: under
`stdio`, stdout is the protocol wire, and dotenv greets it with a banner by
default.

Quality gates (typecheck, Biome, tests, commit convention) run from git hooks
locally and again in CI; see `.github/workflows/`. Releases are cut automatically
by semantic-release when Conventional Commits merge to `main` — nobody bumps a
version by hand.

Publishing goes through
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
`.github/workflows/release.yml` mints a short-lived OIDC token and trades it with
the registry, so there is no long-lived npm credential to leak or rotate. Every
published version carries a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
linking the tarball back to the commit and workflow run that built it — the
"Built and signed on GitHub Actions" line on the npm page.

## License

[MIT](LICENSE)

# mcp-whoop

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [WHOOP](https://www.whoop.com), served over stdio.

Published on npm as [`mcp-whoop`](https://www.npmjs.com/package/mcp-whoop).

> **Status: early development.** The server scaffolding is in place and speaks the current MCP spec revision (2026-07-28) via SDK v2; the WHOOP tools are still landing. For now it serves a single `hello` tool as a tracer bullet.

## Usage

Run directly with `npx` (Node.js `^22.22.1 || >=24.10.0`):

```sh
npx mcp-whoop
```

Or add it to an MCP client's configuration:

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

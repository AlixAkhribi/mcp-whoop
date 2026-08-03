import { defineConfig } from "tsdown";

/**
 * Builds the one artifact this package ships: the `dist/index.js` bin. tsdown
 * resolves the extensionless and `@/…` imports the compiler only checks,
 * keeps `dependencies` external so the tarball stays a thin wrapper over
 * `zod` and the MCP SDK, and splits the `login`/`logout`/`stdio` dynamic
 * imports into chunks so the lazy dispatch in `src/index.ts` survives
 * bundling.
 */
export default defineConfig({
	entry: "src/index.ts",
	format: "esm",
	// Emit `.js`, not `.mjs`: `"type": "module"` already makes `.js` ESM, and
	// `bin` points at `dist/index.js`.
	fixedExtension: false,
	platform: "node",
	target: "es2022",
	sourcemap: true,
	// Nothing imports this package — it is a bin, with no `exports` or `main` —
	// so declaration files would be dead weight in the tarball.
	dts: false,
	// `files: ["dist"]` packs whatever sits in `dist/`; without a wipe, stale
	// output from a previous build would ride along into the published tarball.
	clean: true,
});

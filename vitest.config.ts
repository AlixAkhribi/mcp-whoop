import { defineConfig } from "vitest/config";

export default defineConfig({
	// Makes the "@/…" aliases from tsconfig.json resolve in tests.
	resolve: { tsconfigPaths: true },
	test: {
		include: ["tests/**/*.test.ts"],
		globalSetup: ["tests/build-dist.ts"],
	},
});

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTokenStorePath } from "@/auth/tokens/store";

/**
 * A home directory built with `join`, like every expectation below, so the
 * suite asserts the same separators on every host it runs on.
 */
const home = join("/", "home", "ada");

describe("the token store location", () => {
	it("sits in the platform-local per-user data directory by default", () => {
		const localAppData = join("C:", "Users", "Ada", "AppData", "Local");

		expect(
			resolveTokenStorePath({
				platform: "win32",
				env: { LOCALAPPDATA: localAppData },
				home,
			}),
		).toBe(join(localAppData, "mcp-whoop", "tokens.json"));

		expect(resolveTokenStorePath({ platform: "win32", env: {}, home })).toBe(
			join(home, "AppData", "Local", "mcp-whoop", "tokens.json"),
		);

		expect(resolveTokenStorePath({ platform: "darwin", env: {}, home })).toBe(
			join(home, "Library", "Application Support", "mcp-whoop", "tokens.json"),
		);

		expect(resolveTokenStorePath({ platform: "linux", env: {}, home })).toBe(
			join(home, ".local", "share", "mcp-whoop", "tokens.json"),
		);

		expect(
			resolveTokenStorePath({
				platform: "linux",
				env: { XDG_DATA_HOME: join(home, "data") },
				home,
			}),
		).toBe(join(home, "data", "mcp-whoop", "tokens.json"));
	});

	it("moves into the WHOOP_TOKEN_STORE directory when one is set", () => {
		const override = join(home, "elsewhere");

		expect(
			resolveTokenStorePath({
				platform: "linux",
				env: { WHOOP_TOKEN_STORE: override, XDG_DATA_HOME: join(home, "data") },
				home,
			}),
		).toBe(join(override, "tokens.json"));
	});
});

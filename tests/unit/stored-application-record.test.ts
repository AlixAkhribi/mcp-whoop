import { stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { redactSecrets } from "@/lib/redaction";
import { readStoredTokens, writeStoredTokens } from "@/whoop/auth/tokens/store";

import { temporaryStore } from "../helpers/harness";

/** Distinctive values, so the redaction assertions cannot match by accident. */
const ACCESS_TOKEN = "access-token-6b1f0d";
const REFRESH_TOKEN = "refresh-token-2e7a94";
const CLIENT_SECRET = "client-secret-c40b3f";
const REDIRECT_URI = "http://127.0.0.1:8787/callback-9d5e1a";

describe("the redirect URI recorded beside the application", () => {
	it("is carried on disk without being made a secret, in an owner-only file", async () => {
		const env = { WHOOP_TOKEN_STORE: await temporaryStore() };
		await writeStoredTokens(
			{
				accessToken: ACCESS_TOKEN,
				refreshToken: REFRESH_TOKEN,
				expiresAt: Date.now() + 3_600_000,
				scopes: ["read:profile", "offline"],
				application: {
					clientId: "a-client-id",
					clientSecret: CLIENT_SECRET,
					redirectUri: REDIRECT_URI,
				},
			},
			{ env },
		);

		const stored = await readStoredTokens({ env });
		expect(stored?.application?.redirectUri).toBe(REDIRECT_URI);

		// The redirect URI is a registered callback address, not secret material:
		// scrubbing it would gut the checklists that name which URI a login could
		// not be finished at. The secrets beside it are still scrubbed.
		expect(redactSecrets(`sent back to ${REDIRECT_URI}`)).toBe(
			`sent back to ${REDIRECT_URI}`,
		);
		for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
			expect(redactSecrets(`held ${secret}`)).not.toContain(secret);
		}

		// Windows has no POSIX mode bits: `stat` reports 0o666 there whatever the
		// file's ACL says, so the mode is only meaningful elsewhere.
		if (process.platform !== "win32") {
			const { mode } = await stat(join(env.WHOOP_TOKEN_STORE, "tokens.json"));
			expect((mode & 0o777).toString(8)).toBe("600");
		}
	});
});

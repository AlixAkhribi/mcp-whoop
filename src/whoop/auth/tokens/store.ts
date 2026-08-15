import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { registerSecrets } from "@/lib/redaction";

/** The directory this package owns inside the per-user data area. */
const STORE_DIRECTORY = "mcp-whoop";

/** The file the token store keeps its JSON in, inside the store directory. */
const TOKEN_FILE = "tokens.json";

/**
 * What the store's location is resolved against. Every field defaults to the
 * running process; passing explicit ones lets the per-platform conventions be
 * asserted from any host.
 */
export type TokenStoreLocation = {
	/** Environment to read `WHOOP_TOKEN_STORE` and the data-area vars from. */
	env?: NodeJS.ProcessEnv;
	/** Platform whose per-user data convention applies. */
	platform?: NodeJS.Platform;
	/** The current user's home directory. */
	home?: string;
};

/**
 * The per-user data area this platform keeps application state in. Always
 * machine-local, never a synced or version-controlled location, because the
 * tokens it holds are credentials.
 */
function dataArea(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	home: string,
): string {
	if (platform === "win32") {
		return env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
	}

	if (platform === "darwin") {
		return join(home, "Library", "Application Support");
	}

	return env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
}

/**
 * Where this server's WHOOP tokens live: inside the platform-local per-user
 * data area, or inside the directory `WHOOP_TOKEN_STORE` names.
 */
export function resolveTokenStorePath({
	env = process.env,
	platform = process.platform,
	home = homedir(),
}: TokenStoreLocation = {}): string {
	const override = env.WHOOP_TOKEN_STORE?.trim();
	const directory =
		override || join(dataArea(platform, env, home), STORE_DIRECTORY);

	return join(directory, TOKEN_FILE);
}

/**
 * The WHOOP application a login belongs to, kept beside the tokens it earned.
 * WHOOP's refresh grant authenticates the application itself, and a serving
 * process spawned by an MCP client carries no WHOOP environment, so it could
 * never rotate the tokens if this pair lived only where the login ran.
 */
export type StoredApplication = {
	/** The application's public identifier at WHOOP. */
	readonly clientId: string;
	/** The application's secret, which signs every refresh grant. */
	readonly clientSecret: string;
};

/** What a login leaves behind. */
export type StoredTokens = {
	/** The short-lived token every WHOOP request carries. */
	readonly accessToken: string;
	/** The single-use token the access token is renewed with. */
	readonly refreshToken: string;
	/** When the access token stops working, in epoch milliseconds. */
	readonly expiresAt: number;
	/** The scopes WHOOP granted, which decide what this server may offer. */
	readonly scopes: readonly string[];
	/**
	 * The application the tokens were issued to. Optional so that a store
	 * without it still loads rather than reading as malformed; a refresh from
	 * such a store authenticates with the environment's credentials instead.
	 */
	readonly application?: StoredApplication;
};

/** What a token file has to hold before this server will act on it. */
const storedTokensSchema = z.object({
	accessToken: z.string(),
	refreshToken: z.string(),
	expiresAt: z.number(),
	scopes: z.array(z.string()),
	application: z
		.object({ clientId: z.string(), clientSecret: z.string() })
		.optional(),
});

/** The file's body as JSON, or undefined when it is not JSON. */
function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

/**
 * Reads the tokens a previous `login` left behind, or `undefined` when no
 * login has ever happened — an expected state with its own message.
 *
 * @throws When a store exists but cannot be read or does not hold tokens:
 * acting on a half-store would send garbage to WHOOP.
 */
export async function readStoredTokens(
	location: TokenStoreLocation = {},
): Promise<StoredTokens | undefined> {
	const path = resolveTokenStorePath(location);

	let body: string;
	try {
		body = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw new Error(`the token store at ${path} cannot be read`);
	}

	const parsed = storedTokensSchema.safeParse(parseJson(body));
	if (!parsed.success) {
		throw new Error(`the token store at ${path} does not hold WHOOP tokens`);
	}
	// Stored secret material enters the process on this read.
	registerSecrets(
		parsed.data.accessToken,
		parsed.data.refreshToken,
		parsed.data.application?.clientSecret,
	);

	return parsed.data;
}

/** These are credentials: only their owner may read or write them. */
const OWNER_ONLY_FILE = 0o600;

/** Likewise for the directory holding them — nobody else needs to list it. */
const OWNER_ONLY_DIRECTORY = 0o700;

/**
 * Deletes the token store, so nothing on this machine can act as the user any
 * more. A store that does not exist is already the goal state, not a failure.
 */
export async function deleteStoredTokens(
	location: TokenStoreLocation = {},
): Promise<void> {
	await rm(resolveTokenStorePath(location), { force: true });
}

/**
 * The errors Windows answers a rename with when something else briefly holds
 * the destination: another writer's replace landing, or a virus scanner
 * opening the freshly written file. POSIX platforms never report these for a
 * plain replace, so retrying on them is a no-op there.
 */
const RENAME_CONTENTION_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How long a contended rename keeps retrying before the error stands. */
const RENAME_DEADLINE_MS = 2_000;

/** How long a contended rename waits before trying again. */
const RENAME_RETRY_AFTER_MS = 10;

/**
 * Renames the temporary file over the store, retrying transient Windows
 * contention until the deadline. Every attempt is still the one atomic
 * replace, so the retry decides only when it lands, not what a reader sees.
 */
async function renameOverStore(temporary: string, path: string): Promise<void> {
	const deadline = Date.now() + RENAME_DEADLINE_MS;

	for (;;) {
		try {
			await rename(temporary, path);

			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (!RENAME_CONTENTION_CODES.has(code) || Date.now() >= deadline) {
				throw error;
			}
			await new Promise<void>((resolve) =>
				setTimeout(resolve, RENAME_RETRY_AFTER_MS),
			);
		}
	}
}

/**
 * Replaces the token store's contents with the given tokens.
 *
 * The write goes to a neighbouring temporary file that is then renamed over the
 * store, so a reader in another process — every MCP client spawns its own —
 * sees either the old tokens or the new ones, never a half-written file. The
 * mode is set explicitly rather than left to the umask, since the risk being
 * guarded against is a refresh token readable by the whole machine.
 */
export async function writeStoredTokens(
	tokens: StoredTokens,
	location: TokenStoreLocation = {},
): Promise<void> {
	const path = resolveTokenStorePath(location);
	const temporary = `${path}.${randomUUID()}.tmp`;

	await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIRECTORY });
	try {
		await writeFile(temporary, `${JSON.stringify(tokens, null, "\t")}\n`, {
			encoding: "utf8",
			mode: OWNER_ONLY_FILE,
		});
		await chmod(temporary, OWNER_ONLY_FILE);
		await renameOverStore(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

import { open, rm, stat } from "node:fs/promises";

import { resolveTokenStorePath, type TokenStoreLocation } from "./store";

/**
 * How long a lockfile may exist before a waiter takes it over. A refresh is one
 * HTTP round trip, so a lock this old belongs to a process that crashed between
 * creating it and removing it. A live holder that is merely slower than this
 * loses its lock; the store's atomic replace and the caller's adopt-on-failure
 * path keep that overlap safe.
 */
const STALE_AFTER_MS = 10_000;

/** How long a waiter sleeps between attempts to create the lockfile. */
const RETRY_AFTER_MS = 25;

/**
 * Where the store's lockfile lives: beside the store, so every process pointed
 * at one store contends on one lock.
 */
export function storeLockPath(location: TokenStoreLocation = {}): string {
	return `${resolveTokenStorePath(location)}.lock`;
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Removes the lockfile if it has sat there past the staleness threshold. */
async function removeIfStale(path: string): Promise<void> {
	let bornAt: number;
	try {
		bornAt = (await stat(path)).mtimeMs;
	} catch {
		// Already gone: the holder released it since the create attempt failed.
		return;
	}

	if (Date.now() - bornAt > STALE_AFTER_MS) {
		await rm(path, { force: true });
	}
}

/**
 * Runs the given work while holding the store's exclusive lock, releasing it
 * even when the work throws.
 *
 * The lock is a lockfile created with the exclusive-create flag: creation is
 * atomic on every platform Node runs on, where POSIX `flock` semantics are not
 * free on Windows, and it needs no dependency. Whoever creates the file holds
 * the lock; everyone else retries until the holder removes it, or takes it over
 * once it has gone stale so a crashed holder cannot wedge every future refresh.
 * Progress therefore needs no timeout: a lock either leaves or goes stale.
 */
export async function withStoreLock<T>(
	location: TokenStoreLocation,
	work: () => Promise<T>,
): Promise<T> {
	const path = storeLockPath(location);

	for (;;) {
		try {
			const handle = await open(path, "wx");
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			await removeIfStale(path);
			await pause(RETRY_AFTER_MS);
		}
	}

	try {
		return await work();
	} finally {
		await rm(path, { force: true });
	}
}

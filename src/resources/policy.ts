/**
 * @file The promises every resource here is served under, named once so they
 * cannot drift from one listing to the next — the same reason every tool
 * shares `READ_ONLY_TOOL_ANNOTATIONS` (`src/tools/annotations.ts`). What is
 * genuinely one resource's own — why it claims no `lastModified`, what makes
 * its answer private — stays beside that resource's registration.
 */

import type { Annotations, CacheHint } from "@modelcontextprotocol/server";

/**
 * What a read answers with, named once: the listing advertises it and the read
 * declares it, and a client that trusted the first would be misled by a second
 * that disagreed. Every resource here answers the same way — the one canonical
 * JSON rendering of its shared answer path.
 */
export const RESOURCE_MIME_TYPE = "application/json";

/**
 * Who every resource here is meant for: the person choosing it out of their
 * client's picker, and the model it is then handed to. Both, because a
 * resource crosses from one to the other — the user initiates the fetch and
 * the assistant reads what comes back.
 *
 * `priority` is absent because nothing here ranks one curated resource above
 * another, and none claims a `lastModified` — each registration says why not,
 * in its own file.
 *
 * Checked against the SDK's own type rather than annotated with it, so a field
 * whose name is misspelled fails to compile here instead of travelling to
 * clients as something none of them reads.
 */
export const RESOURCE_ANNOTATIONS = {
	audience: ["user", "assistant"],
} satisfies Annotations;

/**
 * How long a client may reuse any read served here: not at all, and never
 * shared.
 *
 * Zero — "immediately stale" in the 2026-07-28 revision — because every answer
 * is bound to whoever the stored login belongs to, and `npx mcp-whoop login`
 * can hand the store to a different WHOOP account while the URI, the server
 * and the client's authorization context all look unchanged: everything a
 * cache key is made of. This server could never call such a copy back — it
 * declares `listChanged: false` and accepts no subscription — so no positive
 * lifetime is one it can stand behind. Private, because every answer is one
 * person's day, week or body — and one of them says who that person is.
 */
export const RESOURCE_CACHE_HINT = {
	ttlMs: 0,
	cacheScope: "private",
} satisfies CacheHint;

import type { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * What every tool on this server tells a client about itself before it is
 * called: it only ever reads, and what it reads lives at WHOOP rather than in
 * this process. A client can spare the user a confirmation prompt on the
 * strength of the first, and should expect the same call to answer differently
 * over time on the strength of the second.
 *
 * Shared by every registration rather than repeated in each, so the
 * promise cannot drift from one tool to the next. `destructiveHint` and
 * `idempotentHint` are deliberately absent: the specification gives them
 * meaning only for tools that are not read-only.
 *
 * Checked against the SDK's own type rather than annotated with it, so a hint
 * whose name is misspelled fails to compile here instead of travelling to
 * clients as a field none of them reads.
 */
export const READ_ONLY_TOOL_ANNOTATIONS = {
	readOnlyHint: true,
	openWorldHint: true,
} satisfies ToolAnnotations;

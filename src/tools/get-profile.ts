import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { answerProfile } from "@/answers/profile";
import { profileSchema } from "@/api/data/profile";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

/**
 * No input: whose profile is read follows from the stored login. Spelled as an
 * empty `z.strictObject(...)` so clients see a well-formed object schema in
 * `tools/list` that takes no properties at all, and an argument sent anyway is
 * refused rather than quietly dropped.
 */
const getProfileInputSchema = z.strictObject({});

/** Registers the `get_profile` tool on a server instance. */
export function registerGetProfileTool(server: McpServer): void {
	server.registerTool(
		"get_profile",
		{
			title: "WHOOP profile",
			description:
				"Reads the WHOOP profile of the user this server is logged in as.",
			inputSchema: getProfileInputSchema,
			outputSchema: profileSchema,
			annotations: READ_ONLY_TOOL_ANNOTATIONS,
		},
		observedTool("get_profile", async () => {
			const { profile, json } = await answerProfile();

			return {
				content: [{ type: "text" as const, text: json }],
				structuredContent: profile,
			};
		}),
	);
}

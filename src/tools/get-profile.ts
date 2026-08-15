import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jsonToolResult } from "@/json";
import { profileSchema } from "@/whoop/api/data/profile";
import { readProfile } from "@/whoop/reads/profile";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations";
import { observedTool } from "./observed";

const getProfileInputSchema = z.strictObject({});

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
		observedTool("get_profile", async (_input, ctx: ServerContext) => {
			const profile = await readProfile({
				signal: ctx.mcpReq.signal,
			});

			return jsonToolResult(profile);
		}),
	);
}

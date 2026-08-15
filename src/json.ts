/** The canonical JSON representation exposed by every MCP surface. */
export function formatJson(value: unknown): string {
	const json = JSON.stringify(value, null, "\t");
	if (json === undefined) {
		throw new Error("Cannot present an undefined value as JSON");
	}

	return json;
}

/** The repeated text-plus-structured envelope for JSON tools. */
export function jsonToolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: formatJson(value) }],
		structuredContent: value,
	};
}

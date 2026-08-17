/**
 * @file The shared shape of every "cannot log in" message: the problem, a
 * checklist of items, and the remedy. Shared so the terminal login and the
 * elicited login describe the same failures identically.
 */

/** Where a user registers the WHOOP application these credentials come from. */
export const DEVELOPER_DASHBOARD = "https://developer-dashboard.whoop.com";

/** The parts one of these messages is made of. */
type LoginChecklist = {
	/** What stopped the login, finishing "Cannot log in to WHOOP: ". */
	readonly problem: string;
	/** What is left to do, or to look at, one line each. */
	readonly items: readonly string[];
	/** What the reader does about it, where they are. */
	readonly remedy: string;
};

/** A refusal in this project's checklist shape: complaint, list, what to do. */
export function loginChecklist({
	problem,
	items,
	remedy,
}: LoginChecklist): string {
	return [
		`Cannot log in to WHOOP: ${problem}`,
		...items.map((item) => `  - ${item}`),
		"",
		remedy,
	].join("\n");
}

/**
 * The message for an environment missing credential variables. Only the
 * missing ones are listed; the caller supplies the closing instruction, which
 * differs between a terminal and an MCP client.
 */
export function missingCredentialsMessage(
	missing: readonly string[],
	andThen: string,
): string {
	const one = missing.length === 1;

	return loginChecklist({
		problem: `${
			one ? "an environment variable is" : "environment variables are"
		} missing.`,
		items: missing,
		remedy: `Every user brings their own WHOOP application. Register one in the WHOOP Developer Dashboard (${DEVELOPER_DASHBOARD}), then set the variable${
			one ? "" : "s"
		} above from its settings and ${andThen}.`,
	});
}

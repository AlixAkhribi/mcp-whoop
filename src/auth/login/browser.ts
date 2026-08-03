import { spawn } from "node:child_process";

/**
 * Opens a URL in the platform's default browser, as a courtesy. The login
 * command prints the URL first, so a launch that fails — no desktop session, no
 * handler, a locked-down machine — costs the user nothing but a copy and paste.
 * Every failure is therefore swallowed.
 *
 * Windows has no launcher binary, only `start`, which is a shell built-in. Its
 * first quoted argument is the window title, and the URL is quoted verbatim
 * because `cmd` would otherwise treat the query string's `&` as a separator.
 */
export function openInBrowser(url: string): void {
	const [command, args, verbatim] =
		process.platform === "win32"
			? (["cmd", ["/c", "start", '""', `"${url}"`], true] as const)
			: process.platform === "darwin"
				? (["open", [url], false] as const)
				: (["xdg-open", [url], false] as const);

	try {
		const child = spawn(command, [...args], {
			detached: true,
			stdio: "ignore",
			windowsVerbatimArguments: verbatim,
		});
		child.on("error", () => {
			// Best effort: the URL is already on screen.
		});
		child.unref();
	} catch {
		// Best effort: the URL is already on screen.
	}
}

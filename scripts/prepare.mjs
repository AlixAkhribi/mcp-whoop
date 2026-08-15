import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const huskyBin = "node_modules/husky/bin.js";
const hooksDisabled = process.env.HUSKY === "0";
const installHasNoGitMetadata = !existsSync(".git");
const installHasNoDevDependencies = !existsSync(huskyBin);

if (
	!hooksDisabled &&
	!installHasNoGitMetadata &&
	!installHasNoDevDependencies
) {
	const result = spawnSync(process.execPath, [huskyBin], { stdio: "inherit" });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
	}
}

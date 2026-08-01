/**
 * The pre-commit gate: Biome in write mode over the staged files only. It
 * applies formatting and safe fixes (lint-staged re-stages the result) and
 * fails the commit on anything it cannot fix itself. The rules are Biome's,
 * from `biome.json` — this file only narrows them to what is being committed.
 */
export default {
	"*": "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
};

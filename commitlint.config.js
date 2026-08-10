/**
 * The commit convention: Conventional Commits, plus this project's two hard
 * rules — a scope is never allowed, and a body is always required.
 *
 * Dependabot commits are exempt: their generated bodies cannot be shaped and
 * exceed the 100-character body line limit.
 */
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"scope-empty": [2, "always"],
		"body-empty": [2, "never"],
	},
	ignores: [(message) => message.includes("Signed-off-by: dependabot[bot]")],
};

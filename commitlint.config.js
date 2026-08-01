/**
 * The commit convention: Conventional Commits, plus this project's two hard
 * rules — a scope is never allowed, and a body is always required.
 */
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"scope-empty": [2, "always"],
		"body-empty": [2, "never"],
	},
};

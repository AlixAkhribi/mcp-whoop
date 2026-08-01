/**
 * The release contract: the commits that reach `main` decide the next version,
 * and `.github/workflows/release.yml` is the only thing that runs this.
 *
 * Plugin order is execution order, and the last two entries depend on it:
 * `changelog` has to write CHANGELOG.md before `npm` packs the tarball and
 * before `git` commits it, and `git` runs last so the commit it pushes back to
 * `main` carries the exact `package.json` version and changelog the release
 * shipped with. That commit is the one machine-written commit this repo
 * allows; its message is customized below because the plugin's default —
 * `chore(release): …` — uses a scope, and this repo's commitlint config
 * forbids scopes and requires a body. The `[skip ci]` marker stops the push
 * from re-triggering the release workflow, which would otherwise run once
 * more only to find nothing new to release.
 */
export default {
	// The one branch the release workflow triggers on. The default list also
	// covers `master`, `next`, and the pre-release branches; none of them exist
	// here, and a release should never come from a branch nobody protects.
	branches: ["main"],
	plugins: [
		// Reads the Conventional Commits since the last tag and picks the bump.
		"@semantic-release/commit-analyzer",
		// Turns those same commits into the release notes.
		"@semantic-release/release-notes-generator",
		// Prepends those notes to CHANGELOG.md in the workspace.
		"@semantic-release/changelog",
		// Writes the version into package.json and runs `npm publish`. On
		// npmjs.org it first trades the job's GitHub OIDC token for a
		// short-lived publish token, which is why the workflow needs
		// `id-token: write` and no npm token at all.
		"@semantic-release/npm",
		// Publishes the release notes as a GitHub release; semantic-release
		// itself pushes the `v${version}` tag it hangs from.
		"@semantic-release/github",
		// Commits the bumped package.json and CHANGELOG.md back to `main`, so
		// the version in git always matches the version on npm.
		[
			"@semantic-release/git",
			{
				assets: ["package.json", "CHANGELOG.md"],
				message:
					// biome-ignore lint/suspicious/noTemplateCurlyInString: a Lodash template semantic-release fills at release time, not a JS template literal
					"chore: release ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
	],
};

# Releasing

## Before you start: no git dependencies

`npm publish` ships `dependencies` verbatim, and `publish.yml` has no check for this — a
`git+https://…#<sha>` entry left in `package.json` would make every `npm install coolhand-cli`
require `git` and network access to GitHub and resolve to an unmerged branch commit instead of a
published release. We pin to a commit while a `coolhand-node` PR is in review (see the `[0.10.0]`
and `[0.11.0]` `coolhand-node` entries in `CHANGELOG.md`), so check before every release:

```bash
node -p "Object.entries(require('./package.json').dependencies).filter(([,v]) => /^(git(\+[a-z]+)?:|github:|gitlab:|bitbucket:|gist:)/.test(v))"
```

If that prints anything other than `[]`, stop: wait for the upstream release, change the entry back
to a `^x.y.z` range, run `npm install` to refresh `package-lock.json`, and note the un-pin under
`### Changed` in `CHANGELOG.md`.

## Live smoke test

Before a release, run the live smoke test against a real configured client:

```bash
npm run build && npm run live-smoke
```

It runs read-only `coolhand` commands (`whoami`, `list-workloads`, `search-templates`, `search-logs`) against the real Coolhand API. `npm run live-smoke` re-runs [`examples/live-smoke-test.sh`](./examples/live-smoke-test.sh) under `zsh -ic` when `zsh` is installed, so credentials exported from your zsh profile (`COOLHAND_PRIVATE_KEY`, `COOLHAND_CLIENT_ID`, …) are visible even from a non-interactive shell such as an agent's tool shell. Your `.zshrc` runs in full, so it can change `PATH` (nvm, asdf) or print banners; if it hangs or misbehaves in a non-TTY shell, set `COOLHAND_EXAMPLES_NO_ZSH=1` to skip the re-exec and use the current shell's environment as-is.

Credentials come from a stored login (`~/.coolhand/config.json`, or `COOLHAND_CONFIG_DIR`) or from the environment (`COOLHAND_PRIVATE_KEY` when no client is stored; `COOLHAND_CLIENT_ID` selects among stored clients). The output starts with a `Credential source:` line saying which was used. An env-only `COOLHAND_PRIVATE_KEY` exercises just `list-workloads`; `search-templates` and `search-logs` need a stored login and will `SKIP`.

If no credentials are found, the script exits 0 but prints `SKIPPED (no live call was made)` followed by what it looked at (config path, which env vars are set, which shell). A skip means the release was **not** live-validated — fix the cause and re-run rather than treating it as a pass.

## Release Process

Releases are built by running the `/prep-release` skill (`.claude/skills/prep-release/SKILL.md`). It triages open PRs, gets your sign-off on which ship, squash-merges them, and builds a `release/vX.Y.Z` branch that bumps `package.json`'s version, updates `CHANGELOG.md` and docs, and red-teams the whole package — then opens a release-prep PR for your review. Per `AGENTS.md`'s "Changelog and versioning" rule, `package.json`'s version and `CHANGELOG.md` are only ever edited there, never on feature/fix branches.

`/prep-release` never tags, pushes, or publishes. Once its release-prep PR is reviewed and merged into `main`, tag and push it yourself — this is what triggers the release:

```bash
git tag vX.Y.Z
git push origin main --tags
```

Pushing a `vX.Y.Z` tag runs [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which lints, type-checks, tests, and builds the package fresh, verifies the tag matches `package.json`'s version (failing the run otherwise), then publishes to npm using [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) with `--provenance` — no `NPM_TOKEN` secret is stored anywhere. Publishing runs in a separate job scoped to the `npm-publish` GitHub Environment, gated behind the build/verify job passing.

Watch the [Actions tab](https://github.com/Coolhand-Labs/coolhand-cli/actions/workflows/publish.yml) for the run; a failure there (including a tag/version mismatch) means the package was **not** published.


# Releasing

## Release Process

Releases are built by running the `/prep-release` skill (`.claude/skills/prep-release/SKILL.md`). It triages open PRs, gets your sign-off on which ship, squash-merges them, and builds a `release/vX.Y.Z` branch that bumps `package.json`'s version, updates `CHANGELOG.md` and docs, and red-teams the whole package — then opens a release-prep PR for your review. Per `CLAUDE.md`'s "Changelog and versioning" rule, `package.json`'s version and `CHANGELOG.md` are only ever edited there, never on feature/fix branches.

`/prep-release` never tags, pushes, or publishes. Once its release-prep PR is reviewed and merged into `main`, tag and push it yourself — this is what triggers the release:

```bash
git tag vX.Y.Z
git push origin main --tags
```

Pushing a `vX.Y.Z` tag runs [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which lints, type-checks, tests, and builds the package fresh, verifies the tag matches `package.json`'s version (failing the run otherwise), then publishes to npm using [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) with `--provenance` — no `NPM_TOKEN` secret is stored anywhere. Publishing runs in a separate job scoped to the `npm-publish` GitHub Environment, gated behind the build/verify job passing.

Watch the [Actions tab](https://github.com/Coolhand-Labs/coolhand-cli/actions/workflows/publish.yml) for the run; a failure there (including a tag/version mismatch) means the package was **not** published.


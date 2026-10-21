---
name: finish-release
description: |
  Finishes a release once its release-prep PR (from /prep-release) has been
  merged: creates and pushes the annotated vX.Y.Z tag on the release-prep
  merge commit, then publishes the GitHub release notes in the same format as
  the previous release. Pushing the tag triggers the Publish workflow (npm
  Trusted Publishing), so this is the step that ships the package. Use when
  the user types /finish-release, asks to "tag the release", "publish the
  release notes", "ship v0.x.y", or has just merged the release-prep PR.
user_invocable: true
version: 1.0.0
---

# Finish Release

The counterpart to `/prep-release`. That skill stops at an open release PR and
never tags or publishes; this one starts after the user has reviewed and merged
that PR. Running it is the user's go-ahead to tag and publish. It automates the
tag-and-push step of `RELEASING.md`, then writes the release notes. Two steps,
in this order: **tag, then release notes**. The release is created with
`--verify-tag`, so the tag has to exist first.

**What pushing the tag does:** `.github/workflows/publish.yml` runs on any
`v*.*.*` tag push. The `build` job runs lint, typecheck, tests, build and the
smoke test, and fails if the tag differs from `package.json`'s version. The
`publish` job then runs `npm publish --provenance` (Trusted Publishing/OIDC,
no token) in the `npm-publish` environment, which may wait for a human
approval. The workflow does **not** create a GitHub release; Phase 3 does.

## Phase 1: Preconditions (abort on any failure, change nothing)

1. `git fetch origin main --tags`.
2. Read the version from `origin/main`, not from the working tree:
   `git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0)).version"`.
   Call it `X.Y.Z`; the tag is `vX.Y.Z`.
3. Check all of these, and stop and tell the user which one failed:
   - `X.Y.Z` is greater than the latest tag (`git describe --tags --abbrev=0
     origin/main`). If equal, the release PR has not merged yet (or the
     version was never bumped).
   - `git show origin/main:CHANGELOG.md` has a `## [X.Y.Z] - <date>` heading,
     and `origin/main:package-lock.json` has the same top-level `version`.
   - **No git dependencies** (the check from `RELEASING.md`): run its
     `node -p "...filter(...)"` one-liner against
     `git show origin/main:package.json`. Anything but `[]` (e.g. a
     `coolhand-node` pinned to a commit) means stop; `npm publish` would ship
     it verbatim. Also confirm each `dependencies` range resolves on npm
     (`npm view coolhand-node@"<range>" version`).
   - The tag does not already exist, locally (`git tag -l vX.Y.Z`) or on the
     remote (`git ls-remote --tags origin 'vX.Y.Z*'`), and no release exists
     (`gh release view vX.Y.Z` fails). If the tag exists but the release does
     not, skip Phase 2 and resume at Phase 3, after confirming the tag points
     at the release commit from step 4.
4. Find the **release commit**, the oldest commit on `origin/main` that
   introduced the version: `git log origin/main --format='%H %s' -S'"version":
   "X.Y.Z"' -- package.json`, last line. Cross-check it against the merged
   release-prep PR (`gh pr list --state merged --search "release vX.Y.Z in:title"
   --json number,mergeCommit`; older releases were a direct commit, so a missing
   PR is not fatal). The tag target is this commit, **not** `origin/main` HEAD:
   unrelated PRs can merge after the release PR (v0.11.1 sits one commit behind
   main), and tagging HEAD would publish changes the changelog never covered.
   Do not tag a local branch or a stale checkout.

## Phase 2: Tag

1. `git tag -a vX.Y.Z <release commit sha> -m "vX.Y.Z"`. Annotated, like
   `v0.10.0` (check with `git cat-file -t`). `RELEASING.md` shows a plain
   `git tag`; both trigger the workflow, and annotated records who tagged.
2. `git push origin refs/tags/vX.Y.Z`. Push only that ref, never `--tags` and
   never `main` (`RELEASING.md`'s `git push origin main --tags` would push every
   local tag).
3. Verify with `git ls-remote --tags origin 'vX.Y.Z*'`. The `git push` output
   can be swallowed by the shell's output filter, so don't trust its silence;
   the `^{}` line must show the release commit.

Never `npm publish` by hand; CI publishes.

## Phase 3: Release notes

1. Fetch the previous release as the format template:
   `gh release view v<previous> --json body --jq .body`. Match its structure and
   tone (plain headings, no emoji): `## coolhand-cli vX.Y.Z`, a
   `**Month YYYY** · [npm](https://www.npmjs.com/package/coolhand-cli) ·
   [GitHub](https://github.com/Coolhand-Labs/coolhand-cli)` line (month from the
   CHANGELOG date), `### What's new in vX.Y.Z` (one paragraph: what shipped,
   and "no new commands or flags" when true), then only the sections that have
   content from `### New commands`, `### Changed`, `### Security`, `### Fixed`,
   and always a closing `### Breaking changes` (`None.` plus why, or the
   migration). There is no Known Follow-ups section in this repo.
2. Source the content from the `## [X.Y.Z]` CHANGELOG section and the merged
   PRs since the previous tag (`git log v<previous>..vX.Y.Z --oneline`), reading
   the PRs and the diff for anything the changelog compresses. Write for users:
   what it does, a short `bash` example for each new command, migration notes
   for anything behavior-affecting. Use full `https://github.com/...` URLs, not
   relative links, because the notes render on the Releases page.
3. **Verify every claim before publishing.** Don't describe a behavior you
   haven't read in the code or the PR; check flags against `docs/commands.md`
   and `src/cli.ts`; run `gh issue view <n> --json state` or `gh pr view <n>` on
   anything you link. A release note that misstates scope is worse than a short
   one.
4. Write the notes to a scratch file outside the repo, e.g.
   `/tmp/release-notes-vX.Y.Z.md`.
5. `gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file
   /tmp/release-notes-vX.Y.Z.md --latest`. Not a draft and not a prerelease,
   same as the previous releases. Confirm with
   `gh release view vX.Y.Z --json name,tagName,isDraft,url`.

## Phase 4: Report

State, in the final message:
- The tag and the commit it points at.
- The release URL.
- The Publish workflow run (`gh run list --workflow publish.yml --limit 1`) and
  whether the `publish` job is waiting on `npm-publish` approval. Do not approve
  it or publish by any other route. A red run (including a tag/version mismatch)
  means the package was **not** published. Check again later if the user asks
  whether it is live: `npm view coolhand-cli version dist-tags` should show
  `X.Y.Z` as `latest`.

## Rationalizations to resist

- *"The version in my checkout says X.Y.Z, close enough."* Read it from
  `origin/main`. Tagging a stale checkout publishes the wrong code.
- *"I'll tag `origin/main` HEAD, it's the same thing."* Not if anything merged
  after the release PR. Tag the release commit.
- *"I'll publish the notes first and tag after."* `--verify-tag` exists so a
  release can't point at nothing; GitHub would otherwise create the tag itself
  from the default branch tip, unannotated and unreviewed.
- *"The dependency pin is only temporary, ship it anyway."* A `git+https://`
  entry makes every `npm install coolhand-cli` need git and resolve to an
  unmerged commit. Wait for the upstream release.
- *"`git push` printed nothing, so it probably worked."* Verify with
  `git ls-remote`.

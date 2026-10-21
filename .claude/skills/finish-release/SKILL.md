---
name: finish-release
description: |
  Finishes a release from its open release-prep PR (from /prep-release):
  squash-merges the PR, creates and pushes the annotated vX.Y.Z tag on the
  merge commit, then publishes the GitHub release notes in the same format as
  the previous release. Pushing the tag triggers the Publish workflow (npm
  Trusted Publishing), so this is the step that ships the package. Invoking it
  is the user's authorization to merge, tag and publish. Use when the user
  types /finish-release, asks to "merge and tag the release", "publish the
  release notes", "ship v0.x.y", or has reviewed the release-prep PR.
user_invocable: true
version: 1.1.0
---

# Finish Release

The counterpart to `/prep-release`. That skill stops at an open `release/vX.Y.Z`
PR and never merges, tags or publishes; this one starts after the user has
reviewed that PR. **Invoking `/finish-release` is the user's authorization to
merge that PR, tag, and publish.** It automates the tag-and-push step of
`RELEASING.md` and goes beyond it (the merge and the release notes). Order:
**preconditions, merge, tag, release notes, report.** The release is created
with `--verify-tag`, so the tag has to exist first.

**What pushing the tag does:** `.github/workflows/publish.yml` runs on any
`v*.*.*` tag push. The `build` job runs lint, typecheck, tests, build and the
smoke test, and fails if the tag differs from `package.json`'s version. The
`publish` job then runs `npm publish --provenance` (Trusted Publishing/OIDC,
no token) in the `npm-publish` environment, which may wait for a human
approval. The workflow does **not** create a GitHub release; Phase 4 does.

## Phase 1: Preconditions (abort on any failure, change nothing)

1. `git fetch origin main --tags`.
2. Find the release PR. Search by head branch first: `gh pr list --state open
   --json number,title,headRefName,isDraft --jq '.[] |
   select(.headRefName|startswith("release/v"))'`; fall back to a title
   containing "release" (titles have varied: "chore: release v0.11.1",
   "chore: prep 0.11.0 ..."). More than one candidate: ask. None open: look for a
   merged one (`--state merged`) whose version is not tagged yet and take the
   **resume path** (skip Phase 2); if there is none either, stop.
3. Read everything from the PR head, not the working tree:
   `git fetch origin <headRefName>`, then `git show origin/<branch>:package.json`
   (version = `X.Y.Z`, tag = `vX.Y.Z`). A merged PR is read from `origin/main`.
4. Check all of these, and stop and tell the user which one failed:
   - `X.Y.Z` is greater than the latest tag (`git describe --tags --abbrev=0
     origin/main`).
   - `CHANGELOG.md` has a `## [X.Y.Z] - <date>` heading and `package-lock.json`
     has the same top-level `version`.
   - **No git dependencies** (the check from `RELEASING.md`): run its
     `node -p "...filter(...)"` one-liner against the PR head's `package.json`.
     Anything but `[]` (e.g. a `coolhand-node` pinned to a commit) means stop;
     `npm publish` would ship it verbatim. Also confirm each `dependencies`
     range resolves (`npm view coolhand-node@"<range>" version`).
   - PR is open, not a draft, `gh pr view <n> --json mergeStateStatus,mergeable`
     is `CLEAN`/`MERGEABLE`, and every check in `gh pr checks <n>` passed. `main`
     has no branch protection, so "required" means all of them.
   - The tag does not exist, locally (`git tag -l vX.Y.Z`) or on the remote
     (`git ls-remote --tags origin 'vX.Y.Z*'`), and no release exists (`gh
     release view vX.Y.Z` fails). If the tag exists but the release does not,
     skip to Phase 4 after confirming the tag points at the release commit.

## Phase 2: Merge

1. Save the PR body verbatim: `gh pr view <n> --json body --jq .body >
   /tmp/release-pr-body-vX.Y.Z.md`.
2. `gh pr merge <n> --squash --delete-branch --subject "chore: release vX.Y.Z
   (#<n>)" --body-file /tmp/release-pr-body-vX.Y.Z.md`. That is the repo's
   convention (`chore: release v0.11.1 (#151)`); `--subject` is used verbatim, so
   keep the `(#<n>)`. No AI attribution. Never `--admin` or bypass checks; if
   the merge is refused, stop and report.
3. `git fetch origin main --tags`; the merge commit is `gh pr view <n> --json
   mergeCommit --jq .mergeCommit.oid`. Confirm `git show <sha>:package.json` still
   has version `X.Y.Z`. That commit is the tag target, **not** `origin/main` HEAD:
   unrelated PRs can land after it (v0.11.1 sits one commit behind main).
   *Resume path only, when the merged PR can't be found:* use the oldest commit
   that introduced the version, `git log origin/main --format='%H %s'
   -S'"version": "X.Y.Z"' -- package.json`, last line.

## Phase 3: Tag

1. `git tag -a vX.Y.Z <merge commit sha> -m "vX.Y.Z"`. Annotated, like `v0.10.0`
   (`git cat-file -t`). `RELEASING.md` shows a plain `git tag`; both trigger the
   workflow, and annotated records who tagged.
2. `git push origin refs/tags/vX.Y.Z`. Push only that ref, never `--tags` and
   never `main` (`RELEASING.md`'s `git push origin main --tags` would push every
   local tag).
3. Verify with `git ls-remote --tags origin 'vX.Y.Z*'`. The `git push` output
   can be swallowed by the shell's output filter, so don't trust its silence;
   the `^{}` line must show the merge commit. Never `npm publish` by hand.

## Phase 4: Release notes

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
   the PRs and diff for anything the changelog compresses. Write for users: a
   short `bash` example per new command, migration notes for behavior changes,
   full `https://github.com/...` URLs.
3. **Verify every claim before publishing.** Don't describe a behavior you
   haven't read in the code or the PR; check flags against `docs/commands.md`
   and `src/cli.ts`; check `gh issue view <n>` / `gh pr view <n>` on anything
   you link. A note that misstates scope is worse than a short one.
4. Write the notes to `/tmp/release-notes-vX.Y.Z.md` (outside the repo).
5. `gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file
   /tmp/release-notes-vX.Y.Z.md --latest`. Not a draft and not a prerelease,
   same as the previous releases. Confirm with
   `gh release view vX.Y.Z --json name,tagName,isDraft,url`.

## Phase 5: Report

State, in the final message:
- The merged PR number and its merge commit, and the tag (it points at that commit).
- The release URL.
- The Publish run (`gh run list --workflow publish.yml --limit 1`) and whether
  `publish` is waiting on `npm-publish` approval. Never approve it or publish
  another way. A red run means the package was **not** published. If asked
  whether it is live: `npm view coolhand-cli version dist-tags` shows `X.Y.Z` as
  `latest`.

## Rationalizations to resist

- *"My checkout says X.Y.Z, close enough."* Read it from the PR head or
  `origin/main`; a stale checkout publishes the wrong code.
- *"Checks are probably green."* Run `gh pr checks`; the tag ships it.
- *"I'll use the default squash message."* The title and body are the release's
  record on `main`; use the convention and the PR body verbatim.
- *"I'll tag `origin/main` HEAD, it's the same thing."* Not if anything merged
  after the release PR. Tag the merge commit.
- *"I'll publish the notes first and tag after."* Without `--verify-tag`, GitHub
  creates the tag itself from the branch tip, unannotated and unreviewed.
- *"The dependency pin is only temporary, ship it anyway."* Every `npm install
  coolhand-cli` would need git and resolve to an unmerged commit.
- *"`git push` printed nothing, so it probably worked."* Verify with
  `git ls-remote`.

---
name: prep-release
description: |
  Runs an entire release event for this package: triages every open PR into a
  quality/risk-rated merge recommendation, waits for the user's sign-off,
  squash-merges the chosen PRs, writes the release's changelog and version
  bump plus a whole-package security red-team on its own release branch,
  validates that branch with the full verify pass and a live smoke test
  against a real configured client, then opens a single release-prep PR for
  the user's final review. Never merges that PR, tags, or publishes. Use when
  the user types /prep-release, asks to "prep a release", "cut a release",
  "release checklist", or wants the open PRs triaged and merged into a
  release.
user_invocable: true
version: 1.0.0
---

# Prep Release

Five phases, run in order. This is a whole-release audit, not a single-branch
review — Phase 3 onward operates on the whole `src/` tree and everything
merged since the last tag, not just one diff. For an iterative diff-scoped
review during normal development, use `/loop-review` instead; this skill is
for the release event itself.

Per `AGENTS.md`'s "Changelog and versioning" rule, feature/fix branches never
touch `CHANGELOG.md` or `package.json`'s `version` field — this skill is the
only place those get written. If a chosen PR's diff does touch either file,
treat it as a normal part of that PR's diff (don't strip it), but don't let
it change how Phase 3 writes its own entry — Phase 3's changelog write-up is
authoritative regardless of what an individual PR's diff already contains.

## Phase 1: Survey open PRs, recommend a release set

1. `gh pr list --state open --json number,title,author,isDraft,mergeable,mergeStateStatus,statusCheckRollup,additions,deletions,changedFiles,body,headRefName`.
2. For each PR, pull `gh pr diff <n>` and `gh pr checks <n>` and rate two
   independent axes:
   - **Quality** (High/Medium/Low): does the diff include test coverage
     proportional to the `src/` change, is the code consistent with this
     repo's style/conventions (including the "Client selection convention"
     in `AGENTS.md` for any command touching the API), does the PR
     description read as complete work rather than a stub or "WIP, not
     ready" note.
   - **Risk** (High/Medium/Low): does it touch a security- or
     credential-critical path (`src/auth/callback-server.ts`,
     `src/auth/state.ts`, `src/auth/open-browser.ts`, `src/config.ts`,
     `src/proxy/*.ts`, `src/sessions/*.ts`, `src/win-spawn.ts`,
     `src/api/*.ts`) — weight those higher regardless of size; failing CI
     checks or a non-clean `mergeable` state also push risk up; an isolated
     additive command or docs-only change is lower risk.
3. Present one table: PR number, title, quality, risk, CI status, mergeable
   state, and a one-line recommendation (include / exclude / needs work
   before it can be considered). Call out anything that looks unfinished —
   draft, a WIP-sounding title, failing checks, an empty or placeholder
   description, visible `TODO`/`FIXME` in the diff — as "exclude, not ready"
   rather than rating it neutrally.
4. Stop here and ask the user which PRs to include in this release. This is
   the one planned decision point in the whole skill — do not merge, write
   changelog entries, or touch `package.json`'s version until the user
   answers. (Phase 2 step 3 below has its own unplanned-error stop for an
   unclean working tree; that's an abort on unexpected state, not a second
   decision point like this one.)

## Phase 2: Merge the chosen PRs

Process the user's chosen PRs one at a time, not as a batch:

1. Before each merge, re-check that PR's `mergeable`/`mergeStateStatus`
   (`gh pr view <n> --json mergeable,mergeStateStatus`) — an earlier merge in
   this same run can newly conflict a later one. If a chosen PR now
   conflicts, skip it, note it in the running list as "skipped — needs
   rebase," and continue with the rest. Don't resolve conflicts on someone
   else's branch unilaterally.
2. `gh pr merge <n> --squash --delete-branch` for each surviving PR.
3. After each merge, sync local `main` before evaluating the next PR. First
   check `git status --porcelain` — if it's not empty, stop and surface it
   to the user rather than discarding unknown local state; otherwise
   `git fetch origin main && git checkout main && git reset --hard
   origin/main` is safe, since it only overwrites a working tree already
   confirmed clean with the just-fetched remote `main`.

Keep a running list of what actually merged vs. what got skipped — Phase 5
reports both.

## Phase 3: Build the release branch — docs/changelog/version + red-team

Determine the version number first — apply step 5's SemVer rules below to
`git log <last-tag>..HEAD --oneline` — then create `release/vX.Y.Z` off the
freshly synced `main` and do all of the following as commits on that branch
— never on `main` directly.

### Docs, changelog, version

1. Find the last release tag: `git describe --tags --abbrev=0`.
2. Diff **everything since that tag** on the now-updated `main` —
   `git log <last-tag>..HEAD --oneline` and `git diff <last-tag>..HEAD --
   src/` — not just the PRs this run merged in Phase 2. `main` can carry
   unreleased changes Phase 2 never touched (a hotfix committed directly, a
   PR merged manually outside this skill, or a prior `/prep-release` run
   that merged PRs but was interrupted before finishing this phase); all of
   those still need a changelog entry, so treat this diff, not Phase 2's
   merge list, as the source of truth for what's covered.
3. For each change, check it's reflected in:
   - `CHANGELOG.md` — one entry per change under `[Unreleased]` (retitle
     that heading to `## [X.Y.Z] - <today's date>` once every change is
     accounted for — don't start a new heading from scratch if
     `[Unreleased]` already exists) in Keep a Changelog format matching
     this repo's existing entries — user-facing behavior, not commit
     messages. Attribute each entry to its PR number where one exists:
     check Phase 2's merge list first, then fall back to the squash-merge
     commit message (`git log --grep`, which carries the PR number in its
     title) for anything not merged in this run. If a change genuinely has
     no discoverable PR (a direct commit to `main`), write the entry
     without one rather than skipping it.
   - `docs/commands.md` — the canonical flag reference. Per `AGENTS.md`'s
     "Docs" and "Client selection convention" sections, any new/changed CLI
     command or flag (including `--client-id` on commands that call the
     API) must be documented here.
   - `README.md` — only the short command table and quick-start bits per
     `AGENTS.md`'s "README and docs philosophy" (auth flow, config schema,
     and session-capture details belong in their dedicated `docs/*.md`
     files, not the README).
4. **Clean, don't just append.** Look for docs that are now stale,
   contradictory, or redundant given the accumulated changes since the last
   tag — consolidate/rewrite rather than layering a new paragraph on top of
   an outdated one. Remove docs for anything removed from the CLI.
5. **Bump the version.** Since `AGENTS.md` now forbids per-PR bumps, this
   should always be needed — but check `package.json`'s `version` against
   the last tag first as a defensive sanity check in case something bumped
   it out of band. Determine the SemVer bump type from `git log
   <tag>..HEAD --oneline`: any new command/flag/feature → `minor`; only
   fixes, docs, or internal changes → `patch`; any change documented as
   breaking (removed/renamed command, flag, or config field) → `major`. Run
   `npm version <patch|minor|major> --no-git-tag-version` (updates
   `package.json` and `package-lock.json`; `--no-git-tag-version` is
   required since tagging stays a manual, post-merge step per
   `RELEASING.md`). `src/version.ts` is gitignored and regenerated from
   `package.json` by `npm run build`'s `sync-version` step (Phase 4.1) —
   never edit or commit it directly.

### Red-team

Adversarially review the entire `src/` tree (not just what merged in Phase
2) for security issues. This CLI stores API credentials locally, runs an
OAuth login flow, and MITM-proxies outbound LLM traffic, so hunt
specifically for:

- **Command/argument injection**: anywhere a child process is spawned
  (`src/proxy/wrap-runner.ts`, `src/auth/open-browser.ts`,
  `src/win-spawn.ts`) or a shell string is built from user/config input.
- **Path traversal / unsafe file I/O**: config file writes (`~/.coolhand/`),
  session capture/scanning (`src/sessions/*.ts`), proxy cert storage
  (`src/proxy/certs.ts`).
- **Secret handling**: API tokens/keys in `src/config.ts` and callers — are
  they masked in all output paths (`status`, `whoami`, `clients`, `--json`),
  ever logged in full, or written with overly permissive file permissions?
- **SSRF / unsafe network calls**: outbound `fetch`/URL construction from
  user-controlled input (`src/api/last-sync.ts`, `src/proxy/sender.ts`,
  callback server URLs).
- **Auth/callback correctness**: `src/auth/callback-server.ts` and
  `src/auth/state.ts` — state-parameter validation, timing, origin checks,
  whether the local callback server could accept connections from anything
  other than the intended browser redirect, and that it's still bound to
  loopback only.
- **MITM proxy / TLS handling**: `src/proxy/certs.ts` and
  `src/proxy/proxy.ts` — CA generation, trust store instructions, whether
  captured traffic could leak to unintended destinations.
- **Injection into stored/forwarded data**: feedback and session payloads
  (`src/api/feedback-client.ts`, `src/sessions/*`) forwarded to the API
  without sanitization where it matters.

For each finding, report file, line, a concrete failure scenario, and
severity. Apply safe, mechanical, low-risk fixes directly, as commits on
`release/vX.Y.Z` (e.g. a missing mask, a missing timeout). Flag but do not
silently apply anything that's a behavior/architecture decision (e.g.
changing a fail-open default, adding new validation that could reject
previously-accepted input) — surface these to the user for a decision, the
same "hand it to a human" rule `/loop-review` uses for stuck findings.

## Phase 4: Validate the release branch

1. Run the project's standard verify pass on `release/vX.Y.Z`, per
   `AGENTS.md`: `npm run build && npm run lint && npm run typecheck && npm
   test`, plus `npm audit` for known dependency vulnerabilities. Everything
   must be clean before continuing — a release doesn't ship on a red build
   or an unaudited dependency tree. If anything fails, stop here and report
   it; fixing genuine bugs takes priority over the rest of this phase and
   Phase 5.

2. If Phase 4.1 is green, run `bash examples/live-smoke-test.sh` (after the
   build in 4.1 has already produced `dist/`). It runs a handful of
   read-only `coolhand` commands (`whoami`, `list-workloads`,
   `search-templates`, `search-logs`) against whatever client is configured
   locally, hitting the real Coolhand API. The whole script skips cleanly
   (exit 0, clear message) if no client is configured at all; individual
   commands also report a per-command `SKIP` (not a `FAIL`) when the
   failure is a local config-state issue rather than an API problem —
   `NO_PRIVATE_KEY` (the default `coolhand login` only grants a public key;
   `list-workloads`/`search-templates`/`search-logs` need a private one) or
   `NOT_CONFIGURED` (e.g. multiple stored clients with no default set).
   Treat both the whole-script skip and any per-command `SKIP` as a skip,
   not a failure, but investigate any command that reports `FAIL` — that's
   a real API-level problem this release would ship with. Record
   pass/skip/fail per command.

## Phase 5: Open the release-prep PR, report everything

1. Push `release/vX.Y.Z` and `gh pr create` (e.g. "chore: release vX.Y.Z")
   targeting `main`. This PR is the user's final checkpoint before the
   changelog/version/red-team commit lands — never merge it, tag it, or run
   the tag-and-push trigger yourself.
2. Report one consolidated summary covering the whole run:
   - Phase 1's PR table and which PRs the user chose.
   - Phase 2's outcome: which PRs merged, which were skipped for new
     conflicts (and need a rebase before the next release).
   - The release-prep PR link, the version bump and why.
   - Docs updated.
   - Red-team findings split into fixed vs. flagged-for-decision.
   - Phase 4.1's build/lint/typecheck/test/audit result.
   - Phase 4.2's live-smoke-test pass/skip/fail per command.

## Safety

- Bumping `package.json`'s version, finalizing the CHANGELOG heading, and
  running `npm install` for the lockfile are all in scope and don't need a
  stop-and-ask — they're mechanical, reversible, and gated on Phase 4
  already being green before the PR opens.
- Squash-merging PRs the user explicitly chose in Phase 1, and pushing the
  `release/vX.Y.Z` branch to open its own PR, are both in scope.
- Never push a commit directly to `main`. All release-branch work lands on
  `main` only via the Phase 5 PR, which the user reviews and merges
  themselves.
- Never create or push a git tag, and never merge the Phase 5 PR yourself.
  Tagging and pushing (which triggers `.github/workflows/publish.yml`'s
  Trusted Publishing run, per `RELEASING.md`) are the user's action once
  they've reviewed and merged this skill's PR, not something this skill
  does.

## Rationalizations to resist

- *"This PR's CI is green and the diff is small, I don't need to look at
  the actual diff."* CI passing doesn't rule out unfinished work — a small,
  green diff can still be a stub that leaves a feature half-built. Read the
  diff.
- *"The diff since the last tag is small, I'll skip the red-team."* Small
  diffs can still sit on top of latent issues in code nobody's touched
  recently — that's exactly what "whole `src/` tree, not just the diff"
  means.
- *"Tests pass, so coverage is fine."* Passing tests and meaningful
  coverage are different questions. A red build blocks release; a green
  build with hollow tests doesn't guarantee anything.
- *"Docs are close enough, I'll skip the cleanup pass."* Accumulated
  changes since the last tag are exactly when docs drift from behavior —
  this phase exists because per-PR doc updates miss the cross-cutting view.
- *"No client is configured locally, so I'll skip the smoke test entirely
  instead of running it."* Run it anyway — the script itself decides
  whether to skip, and its skip message is part of what Phase 5 reports.
  Silently omitting the step hides that decision from the user.

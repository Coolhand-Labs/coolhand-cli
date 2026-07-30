---
description: Pre-release checklist — run the full test suite, refresh docs against everything merged since the last tag, and red-team the entire package (not just this release's diff) for security issues.
---

Run the pre-release checklist. Bump the version if it hasn't already been bumped, but do NOT tag or push — that trigger step stays manual per RELEASING.md.

## Step 1 — Full Verify Pass

Run the project's single verification pass (per CLAUDE.md — don't run steps individually as a substitute):

```bash
npm run build && npm run lint && npm run typecheck && npm test
```

If anything fails, stop here and report the failure. Do not proceed to later steps until this is clean — a version bump, docs, and security findings are meaningless against a broken build.

## Step 2 — Version Bump (if not already done)

1. Find the last tag: `git describe --tags --abbrev=0`. Compare its version to `package.json`'s current `"version"`.
2. If `package.json` is already ahead of the last tag (someone already bumped it this cycle), skip this step entirely — do not bump twice.
3. Otherwise, inspect `git log <tag>..HEAD --oneline` to pick the semver bump type: any new command/flag/feature → `minor`; only fixes, docs, or internal changes → `patch`; any change documented as breaking (removed/renamed command, flag, or config field) → `major`.
4. Run `npm version <patch|minor|major> --no-git-tag-version` (updates `package.json` and `package-lock.json`; `--no-git-tag-version` is required since tagging is explicitly out of scope here).
5. Report the old → new version and which bump type you chose and why.

## Step 3 — Docs Update (changes since last tag)

1. Enumerate everything merged since the last tag found in Step 2: `git log <tag>..HEAD --oneline` and `git diff <tag>..HEAD --stat`.
2. For every commit in that range, check whether it's reflected in:
   - `CHANGELOG.md` — a version section for the new version from Step 2 (titled `## [X.Y.Z] - <today's date>`; if an `[Unreleased]` section already exists with matching content, just retitle it) with Added/Fixed/Changed/Docs entries matching the existing style (see recent entries for tone — user-facing behavior, not commit messages; include PR/issue refs like `(#71)` where the commit message has them).
   - `docs/commands.md` — the canonical flag reference. Per CLAUDE.md's "Client selection convention" and "Docs" sections, any new/changed CLI command or flag (including `--client-id` on commands that call the API) must be documented here.
   - `README.md` — only the short command table and quick-start bits per CLAUDE.md's "README and docs philosophy" (auth flow, config schema, and session-capture details belong in their dedicated docs/*.md files, not the README).
3. "Clean" means more than additive: remove stale flag/command references, fix descriptions that no longer match current behavior, and fix any drift you find even if unrelated to this release's commits.
4. Apply the doc edits directly (Edit/Write), then summarize what changed and why.

## Step 4 — Security Red-Team (whole package)

This is a full-package audit, not a diff review — scope is all of `src/`, not just what changed since the last tag.

1. Run `npm audit` for known dependency vulnerabilities and note anything high/critical.
2. Spawn an Agent (general-purpose, high effort) with a prompt that has it read through `src/` and adversarially review for:
   - **Command/argument injection** — anywhere a child process is spawned (`proxy/wrap-runner.ts`, `auth/open-browser.ts`) or a shell string is built from user/config input.
   - **Path traversal / unsafe file I/O** — config file writes (`~/.coolhand/`), session capture/scanning (`sessions/*.ts`), proxy cert storage (`proxy/certs.ts`).
   - **Secret handling** — API tokens/keys in `config.ts` and callers: are they masked in all output paths (`status`, `whoami`, `clients`, `--json`), ever logged in full, or written with overly permissive file permissions?
   - **SSRF / unsafe network calls** — outbound `fetch`/URL construction from user-controlled input (`api/last-sync.ts`, `proxy/sender.ts`, callback server URLs).
   - **Auth/callback correctness** — `auth/callback-server.ts` and `auth/state.ts`: state-parameter validation, timing, origin checks, whether the local callback server could accept connections from anything other than the intended browser redirect.
   - **MITM proxy / TLS handling** — `proxy/certs.ts` and `proxy/proxy.ts`: CA generation, trust store instructions, whether captured traffic could leak to unintended destinations.
   - **Injection into stored/forwarded data** — feedback and session payloads (`api/feedback-client.ts`, `sessions/*`) forwarded to the API without sanitization where it matters.
   Ask the agent to report each finding with file:line, a concrete exploit scenario (not just "could be risky"), and severity (critical/high/medium/low). No finding, real or not, should be invented — skip speculative "best practice" nits that don't have a concrete failure scenario.
3. Read the agent's findings yourself and sanity-check the top ones against the actual code before reporting them onward — don't relay unverified claims.

## Step 5 — Summary

Report:
1. **Verify pass**: pass/fail.
2. **Version**: bumped (old → new, and why) or already up to date.
3. **Docs**: what was updated, in which files, and confirmation nothing is stale.
4. **Security**: `npm audit` result + the agent's findings, ranked by severity, each with file:line and exploit scenario.
5. **Release readiness**: a clear go / no-go, with the blocking items listed if no-go. Remind the user that tagging/pushing (`git tag vX.Y.Z && git push origin main --tags`) is still a manual step.

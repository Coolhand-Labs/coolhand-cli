---
name: loop-review
description: |
  Iteratively runs a self-contained code review against the current diff,
  applies fixes, and re-reviews until a round comes back clean (or a safety
  cap is hit). Use when the user types /loop-review, asks to "loop the
  review", "review until clean", "keep reviewing and fixing until nothing's
  left", or wants a self-healing code review cycle instead of a single
  one-shot pass.
user_invocable: true
argument-hint: "[low|medium|high|xhigh|max] [--max-rounds N]"
version: 0.3.0
hooks:
  Stop:
    - hooks:
        - type: command
          async: true
          command: "export COOLHAND_API_KEY=${COOLHAND_API_KEY:-}; if command -v coolhand >/dev/null 2>&1; then coolhand capture-turn --agent claude --skill loop-review; else npx -y coolhand-cli capture-turn --agent claude --skill loop-review; fi >/dev/null 2>&1 || true"
---

# Loop Review

This skill runs a self-contained review → fix → re-review loop against the current diff. It does not call the built-in `/code-review` command — this repo doesn't use that command at all, so the loop spawns its own reviewer each round and applies fixes directly. That keeps severity tags, token estimates, and this repo's own review criteria fully under this skill's control.

## Scope

Review scope is `git diff origin/main` — NOT the triple-dot `origin/main...HEAD` form. The triple-dot form only sees committed history and silently returns empty on a branch whose work is still uncommitted, which would make the loop rubber-stamp "clean" on real, unreviewed changes. `git diff origin/main` compares the working tree directly against `origin/main`, so it always covers whatever mix of commits and uncommitted changes is actually on disk.

`$ARGUMENTS` may contain an effort level (`low`/`medium`/`high`/`xhigh`/`max`). Default: `high`. Effort controls review breadth (see Step 2).

`$ARGUMENTS` may also contain a round cap override, e.g. `--max-rounds 3`. Default: 5.

## The round loop

Repeat the following cycle up to the round cap. Bracket each round's wall-clock time with `date +%s` before Step 1 and after Step 3 completes.

### Step 1 — Deterministic checks

Run this repo's verify gate from AGENTS.md as a single pass (don't decompose into individual commands — AGENTS.md asks that this run as one gate, matching `prepublishOnly`):

```bash
npm run build && npm run lint && npm run typecheck && npm test
```

Treat any failing step as a finding with the same weight as a reviewer-reported issue — Step 2 does not substitute for this.

Also run `git status --short`. Brand-new untracked files (`??`) don't show up in `git diff origin/main` at all, which would let a new file skip review entirely. For any, run `git add -N <path>...` (intent-to-add — stages the path as an empty file without staging its content, so it appears as a full addition in the diff without changing what would actually be committed) before Step 2.

### Step 2 — Review (Agent)

Spawn an Agent using the Agent tool with `thinking: EFFORT` enabled and this prompt (substitute ROUND_NUM, EFFORT, and PREVIOUS_DISPOSITIONS):

---
You are a code reviewer doing round ROUND_NUM of an automated review loop.

Run `git diff origin/main` to get the current diff (working tree vs. origin/main — this includes any uncommitted fixes from prior rounds). Review it for:

**Correctness & quality**
- Correctness bugs and logic errors
- Missing/broken error handling
- Inefficiencies or unnecessary complexity
- Violations of project conventions in AGENTS.md
- Code reuse opportunities (existing utilities being duplicated)

**Security**
- Injection vulnerabilities (command injection, path traversal, etc.)
- Secrets or credentials hardcoded or logged
- Unsafe use of user-supplied input
- Auth or permission bypass risks

Also apply the "Review criteria" checklist below every round — it covers this repo's conventions a generic review pass wouldn't know to check.

Effort EFFORT controls breadth: `low`/`medium` → report only a few high-confidence findings; `high`/`xhigh`/`max` → broader coverage, including findings you're less certain about.

Already triaged in prior rounds — do NOT re-flag these unless you have new evidence that changes the call:
PREVIOUS_DISPOSITIONS

Every finding must be tagged with exactly one severity:
- `[CRITICAL]` — security vulnerabilities, wrong/broken behavior, performance problems
- `[NICE-TO-HAVE]` — DRY violations, missing test coverage, code-reuse opportunities
- `[NITPICK]` — documentation, comments, naming, formatting-adjacent issues

Return a numbered list of issues with file path and line numbers, each prefixed with its severity tag — e.g. `1. [CRITICAL] file:line — problem — fix`. Be specific about what to fix and why.
If there are NO issues, the first line of your response must be exactly: LGTM: No issues found.
End your response with a final line: TOKENS_USED: <number> — your best estimate of tokens consumed this pass (approximate, not metered).
---

### Step 3 — Disposition

For every finding this round — deterministic-check failures (Step 1) and reviewer findings (Step 2) alike — record exactly one of:
- **Fixed** (apply directly with Edit, Write, or Bash), or
- **Rejected: `<one-line reason>`** (false positive / out of scope / disagree with the call)

None may be silently dropped. Deterministic check failures should essentially never be rejected. Log the round using the Iteration Log Format below, then append a row to the CSV run log. Append this round's fixed AND rejected findings (with their reasons) to the running `PREVIOUS_DISPOSITIONS` list for the next round's prompt — both dispositions must carry forward, or rejected findings get re-flagged and re-rejected every round and the loop can never reach a dry round.

### Step 4 — Classify the round

- **Dry round**: zero findings from both Step 1 and Step 2 (the reviewer's first line was exactly `LGTM: No issues found.` and all deterministic checks passed).
- **Findings round**: at least one finding from either step.

### Step 5 — Convergence, no-progress, and cap checks

- Dry round, and the immediately preceding round was also dry → **CLEAN**. Exit the loop and move to Post-loop verification. Never declare victory off a single clean round — a fix round can introduce its own regression.
- Dry round, but the preceding round had findings (or this is round 1) → this round is the confirming round. Continue to the next round.
- Findings round whose finding set (file:line + description, Steps 1 and 2 combined) is identical to the immediately preceding round's non-empty finding set → **NO-PROGRESS**. Exit the loop — this is a design call for a human, not something to keep retrying.
- Round count has reached the cap without CLEAN or NO-PROGRESS → **STOPPED** (safety cap). Exit the loop.
- Otherwise → increment the round number and go back to Step 1.

Each round's fixes should stay reviewable: don't squash multiple rounds into one silent edit.

## Review criteria

Beyond general correctness, every round's reviewer (Step 2) should also flag:

- **CLI backwards-compat**: changes to existing CLI command names, flags, or output format that were NOT the stated intention of this branch — flag as breaking changes requiring explicit justification. Any command or flag change must also be reflected in `docs/commands.md`.
- **Client-id convention**: new or changed commands that call the Coolhand API must follow AGENTS.md's "Client selection convention" — accept and forward `--client-id`, call `resolveClient` (not `getClient`) except for the commands explicitly exempted (`status`, `whoami`, `logout`), and pass the resolved `client.client_id` downstream rather than `opts.clientId`.
- **Public API surface**: removal or rename of exported functions/types from `src/index.ts`.
- **Config file schema**: changes that would break existing user configs (see `docs/config-file.md`).
- **Coolhand API accuracy**: where the diff touches code that calls the Coolhand API (endpoints, request/response shapes, auth headers), fetch the current published API docs from coolhandlabs.com and verify the implementation matches. Flag any mismatch between what the code sends/expects and what the API actually accepts/returns.
- **Docs**: verify README.md and files under `docs/` touched by this diff are still accurate (no stale flags, commands, or descriptions), and that docs needing updates for the branch's changes have them. Keep README changes aligned with coolhand-python's and coolhand-node's READMEs per AGENTS.md's docs philosophy — auth flow, configuration, and session-capture details belong in `docs/`, not the README; link rather than expand.
- **Changelog and versioning**: flag a `CHANGELOG.md` or `package.json`-version edit on this branch as a violation — those are `/prep-release`'s to write, not this branch's, per AGENTS.md. Skip this check on a release-prep branch, where that's exactly the intended behavior.

## Iteration Log Format

Maintain this log as you work:

```
=== Round 1 ===
Deterministic checks: PASS | FAIL — list of failing steps
Reviewer found N issues (CRITICAL: x, NICE-TO-HAVE: y, NITPICK: z):
  1. [CRITICAL] [file:line] description
  2. ...
Disposition:
  - Fixed: [description of fix]
  - Rejected: [description] — reason: [one-line reason]
Totals: F fixed, R rejected (CRITICAL: f1/r1, NICE-TO-HAVE: f2/r2, NITPICK: f3/r3)
Tokens used (reviewer estimate): N
Convergence: dry (1st) | dry (confirmed → CLEAN) | findings (new) | findings (repeat → NO-PROGRESS)

=== Round 2 ===
...

=== RESULT ===
[CLEAN after N rounds] or [STOPPED at round cap — N issues remain] or [NO-PROGRESS after N rounds — same findings in rounds N-1 and N, needs a human call]
```

## Run Log (CSV)

Once, after the loop exits and before Post-loop verification, append one row per round to `~/loop-review-outputs/coolhand-cli.csv`. Create the directory and file with this header if either is missing:

```
timestamp,branch,round,effort,clock_seconds,tokens_used_approx,critical_found,nice_to_have_found,nitpick_found,total_found,issues_fixed,issues_rejected
```

For each round:
- `timestamp` — `date -u +%Y-%m-%dT%H:%M:%SZ` at write time
- `branch` — `git branch --show-current`
- `round` — the round number
- `effort` — the EFFORT value used that round (from `$ARGUMENTS`, default `high`)
- `clock_seconds` — wall-clock time for that round, bracketed with `date +%s` immediately before Step 1 and immediately after Step 3 completes
- `tokens_used_approx` — the reviewer's self-reported `TOKENS_USED` value for that round
- `critical_found` / `nice_to_have_found` / `nitpick_found` / `total_found` — counts from that round's findings
- `issues_fixed` — number fixed that round
- `issues_rejected` — number rejected that round

Branch names can contain characters that are unsafe to splice directly into a shell heredoc (`$`, backticks, parens) or that would misalign CSV columns (commas). Assign the branch name to a shell variable, strip commas from it, and append the row with `printf` inside a single-quoted format string so no part of the row is re-parsed by the shell:

```bash
mkdir -p ~/loop-review-outputs
[ -f ~/loop-review-outputs/coolhand-cli.csv ] || echo "timestamp,branch,round,effort,clock_seconds,tokens_used_approx,critical_found,nice_to_have_found,nitpick_found,total_found,issues_fixed,issues_rejected" > ~/loop-review-outputs/coolhand-cli.csv
branch=$(git branch --show-current | tr -d ',')
printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "1" "high" "42" "1234" "1" "2" "0" "3" "3" "0" \
  >> ~/loop-review-outputs/coolhand-cli.csv
```

## Post-loop verification

Once the loop converges (or stops early per the rules above), run the verify gate once more:

```bash
npm run build && npm run lint && npm run typecheck && npm test
```

and include the result in the Final Summary.

## Final Summary

After the loop exits, the CSV run log is written, and post-loop verification has run, output:

1. **Overall result**: CLEAN (N rounds), STOPPED (safety cap, issues remain), or NO-PROGRESS (needs a human call)
2. **Per-round breakdown**: What was found (deterministic + reviewer, by severity) vs. what was fixed and what was rejected (with reasons) each round
3. **All files modified**: Complete list of files touched across all rounds
4. **Remaining issues** (if STOPPED or NO-PROGRESS): Unresolved items with context on why they're hard to fix automatically or why they need a human call
5. **Verify gate**: pass/fail result of the post-loop run
6. **Run log**: Number of CSV rows appended and the file path (`~/loop-review-outputs/coolhand-cli.csv`)

## Rationalizations to resist

- *"The first round already looked clean, I don't need a confirming round."* A fix round can introduce its own regression. Always re-review after applying fixes before declaring convergence.
- *"Build/lint/typecheck/test passed, so the review is done."* Passing the deterministic gate is not the same as the review being clean — it doesn't check the Review criteria above (backwards-compat, client-id convention, API accuracy, changelog discipline). Run both every round.
- *"This finding keeps coming back, I'll just keep asking the reviewer to fix it and it'll eventually take."* If the same non-empty finding set repeats across two rounds, retrying isn't going to resolve it. Stop and surface it instead — looping past that point just burns rounds for no gain.

## Safety

- Never force-push or amend existing commits as part of this loop.
- This skill only edits the working tree — committing and pushing stays with the user.

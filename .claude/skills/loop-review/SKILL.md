---
name: loop-review
description: |
  Iteratively runs code review against the current diff, applies fixes, and
  re-reviews until a round comes back clean (or a safety cap is hit). Use
  when the user types /loop-review, asks to "loop the review", "review
  until clean", "keep reviewing and fixing until nothing's left", or wants
  a self-healing code review cycle instead of a single one-shot pass.
user_invocable: true
argument-hint: [low|medium|high|max]
version: 0.2.0
---

# Loop Review

Run an automated code review + fix loop on the current branch by delegating each round to the built-in `/code-review` skill, plus a manual supplementary pass for conventions `/code-review` can't see. Keep iterating until two consecutive rounds come back clean, a no-progress condition is detected, or the safety cap is hit.

## Setup

- Effort level: `EFFORT` = `$ARGUMENTS` (default: `high` if blank) — forwarded to `/code-review` every round.
- Max iterations: 5
- Review scope: whatever `/code-review` targets by default (the current diff). No explicit target is passed, so it also picks up uncommitted fixes made in prior iterations.

## Loop Instructions

Repeat the following cycle, starting at ITERATION_NUM = 1, up to 5 times:

### Step 1 — Delegate to /code-review

Invoke the `code-review` skill via the Skill tool with `args: "EFFORT --fix"`. This reviews the current diff at the given effort level and applies fixes to the working tree in the same call. Record the findings it reports.

### Step 2 — Manual Review criteria pass

`/code-review` has no visibility into this repo's conventions. Every round, apply the "Review criteria" checklist below yourself against the same diff. For each item you flag, either fix it directly (Edit, Write, Bash) or reject it with a one-line reason (false positive / out of scope / disagree with the call). Silent skipping is not allowed.

### Step 3 — Classify severity

Tag every finding from Steps 1 and 2 with exactly one severity (keep `/code-review`'s own tag if it provides one; otherwise classify it yourself):

- `[CRITICAL]` — security vulnerabilities, wrong/broken behavior, performance problems
- `[NICE-TO-HAVE]` — DRY violations, missing test coverage, code-reuse opportunities
- `[NITPICK]` — documentation, comments, naming, formatting-adjacent issues

### Step 4 — Classify the round

- **Dry round**: zero findings from both Step 1 and Step 2.
- **Findings round**: at least one finding from either step.

### Step 5 — Convergence, no-progress, and cap checks

- Dry round, and the immediately preceding round was also dry → **CLEAN**. Exit the loop. Never declare victory off a single clean round.
- Dry round, but the preceding round had findings (or this is round 1) → this is the confirming round. Continue to the next iteration.
- Findings round whose finding set (file:line + description, Steps 1 and 2 combined) is identical to the immediately preceding round's non-empty finding set → **NO-PROGRESS**. Exit the loop. This is a design call for a human, not something to keep retrying.
- ITERATION_NUM has reached 5 without CLEAN or NO-PROGRESS → **STOPPED** (safety cap). Exit the loop.
- Otherwise → increment ITERATION_NUM and go back to Step 1.

## Review criteria

Manual supplementary checklist applied every round in Step 2. `/code-review` does not know these repo-specific conventions.

- **CLI backwards-compat**: changes to existing CLI command names, flags, or output format that were NOT the stated intention of this branch — flag as breaking changes requiring explicit justification. Any command or flag change must also be reflected in `docs/commands.md`.
- **Public API surface**: removal or rename of exported functions/types from `src/index.ts`.
- **Config file schema**: changes that would break existing user configs (see `docs/config-file.md`).
- **Coolhand API accuracy**: where the diff touches code that calls the Coolhand API (endpoints, request/response shapes, auth headers), fetch the current published API docs from coolhandlabs.com and verify the implementation matches. Flag any mismatch between what the code sends/expects and what the API accepts/returns.
- **Docs**: verify that README.md and files under `docs/` touched by this diff are still accurate (no stale flags, commands, or descriptions), and that docs needing updates for the branch's changes have them. Do NOT flag missing `CHANGELOG.md` entries or `package.json` version bumps — this repo's CLAUDE.md reserves both for the `/prep-release` skill.

## Iteration Log Format

Maintain this log as you work:

```
=== Iteration 1 ===
Round type: DRY | FINDINGS
/code-review findings: N; manual Review-criteria findings: M
Combined (CRITICAL: x, NICE-TO-HAVE: y, NITPICK: z):
  1. [CRITICAL] [file:line] description — source: code-review | manual
  2. ...
Disposition:
  - Fixed: [description of fix]
  - Rejected: [description] — reason: [one-line reason]
Totals: F fixed, R rejected (CRITICAL: f1/r1, NICE-TO-HAVE: f2/r2, NITPICK: f3/r3)
Convergence: dry (1st) | dry (confirmed → CLEAN) | findings (new) | findings (repeat → NO-PROGRESS)

=== Iteration 2 ===
...

=== RESULT ===
[CLEAN after N iterations] or [STOPPED at max iterations — N issues remain] or [NO-PROGRESS after N iterations — same findings in rounds N-1 and N, needs a human call]
```

## Run Log (CSV)

Once, after the loop exits and before writing the Final Summary, append one row per iteration to `~/loop-review-outputs/coolhand-cli.csv`. Create the directory and file with this header if either is missing:

```
timestamp,branch,iteration,model,thinking_level,clock_seconds,tokens_used_approx,critical_found,nice_to_have_found,nitpick_found,total_found,issues_addressed,issues_ignored
```

For each iteration:
- `timestamp` — `date -u +%Y-%m-%dT%H:%M:%SZ` at write time
- `branch` — `git branch --show-current`
- `iteration` — the iteration number
- `model` — `default` (this skill doesn't pin a specific model per round)
- `thinking_level` — the EFFORT value used for that iteration (from `$ARGUMENTS`, default `high`)
- `clock_seconds` — wall-clock time for that iteration, bracketed with `date +%s` immediately before Step 1 and immediately after Step 2 completes
- `tokens_used_approx` — leave empty; `/code-review` is a built-in call and does not report a token estimate
- `critical_found` / `nice_to_have_found` / `nitpick_found` / `total_found` — combined counts from Step 3
- `issues_addressed` — number fixed that iteration (by `/code-review --fix` plus your own Step 2 fixes)
- `issues_ignored` — number rejected that iteration

Branch names can contain characters that are unsafe to splice directly into a shell heredoc (`$`, backticks, parens) or that would misalign CSV columns (commas). Assign the branch name to a shell variable, strip commas from it, and append the row with `printf` inside a single-quoted format string so no part of the row is re-parsed by the shell:

```bash
mkdir -p ~/loop-review-outputs
[ -f ~/loop-review-outputs/coolhand-cli.csv ] || echo "timestamp,branch,iteration,model,thinking_level,clock_seconds,tokens_used_approx,critical_found,nice_to_have_found,nitpick_found,total_found,issues_addressed,issues_ignored" > ~/loop-review-outputs/coolhand-cli.csv
branch=$(git branch --show-current | tr -d ',')
printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
  "2026-01-01T00:00:00Z" "$branch" "1" "default" "high" "42" "" "1" "2" "0" "3" "3" "0" \
  >> ~/loop-review-outputs/coolhand-cli.csv
```

## Final Summary

After the loop exits and the CSV run log has been written, output:

1. **Overall result**: CLEAN (N iterations), STOPPED (safety cap, issues remain), or NO-PROGRESS (needs a human call)
2. **Per-iteration breakdown**: What was found (by severity, and by source) vs. what was fixed and what was rejected (with reasons) each round
3. **All files modified**: Complete list of files touched across all iterations
4. **Remaining issues** (if STOPPED or NO-PROGRESS): Unresolved items with context on why they need a human
5. **Run log**: Number of CSV rows appended and the file path (`~/loop-review-outputs/coolhand-cli.csv`)

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
version: 0.1.0
---

Run an automated code review + fix loop on the current branch. Keep iterating until the reviewer reports no issues.

## Setup

- Effort level: `$ARGUMENTS` (default: `high` if blank)
- Max iterations: 5
- Review scope: `git diff $(git merge-base origin/main HEAD)` — a single-ref diff against the merge-base, so it also picks up uncommitted fixes from prior iterations (`git diff origin/main...HEAD` would not, since three-dot diffs two commits and ignores the working tree)

## Loop Instructions

Repeat the following cycle up to 5 times:

### Step 1 — Review (Agent)

Spawn an Agent using the Agent tool with `thinking: EFFORT` enabled and this prompt (substitute ITERATION_NUM, EFFORT, and PREVIOUS_DISPOSITIONS):

---
You are a code reviewer doing pass ITERATION_NUM of an automated review loop.

Run `git diff $(git merge-base origin/main HEAD)` to get the current branch diff (this includes any uncommitted fixes from prior iterations). Review it for:

**Correctness & quality**
- Correctness bugs and logic errors
- Missing/broken error handling
- Inefficiencies or unnecessary complexity
- Violations of project conventions in CLAUDE.md
- Code reuse opportunities (existing utilities being duplicated)

**Security**
- Injection vulnerabilities (command injection, path traversal, etc.)
- Secrets or credentials hardcoded or logged
- Unsafe use of user-supplied input
- Auth or permission bypass risks

**Backwards compatibility**
- Any changes to existing CLI command names, flags, or output format that were NOT the stated intention of this branch — flag these as breaking changes requiring explicit justification
- Removal or rename of exported functions/types from the public API surface (src/index.ts)
- Changes to config file schema that would break existing user configs

**Coolhand API accuracy**
- Where the diff touches code that calls the Coolhand API (endpoints, request/response shapes, auth headers), fetch the current published API docs from coolhandlabs.com and verify the implementation matches
- Flag any mismatches between what the code sends/expects and what the API actually accepts/returns

**Documentation**
- Check whether README.md, CHANGELOG.md, or files under docs/ need updates to reflect the changes on this branch
- Verify that any existing documentation touched by this diff is still accurate (no stale flags, commands, or descriptions)
- Flag missing changelog entries for user-visible changes

Effort: EFFORT

Already triaged in prior iterations — do NOT re-flag these unless you have new evidence that changes the call:
PREVIOUS_DISPOSITIONS

Every finding must be tagged with exactly one severity:
- `[CRITICAL]` — security vulnerabilities, wrong/broken behavior, performance problems
- `[NICE-TO-HAVE]` — DRY violations, missing test coverage, code-reuse opportunities
- `[NITPICK]` — documentation, comments, naming, formatting-adjacent issues

Return a numbered list of issues with file path and line numbers, each prefixed with its severity tag — e.g. `1. [CRITICAL] file:line — problem — fix`. Be specific about what to fix and why.
If there are NO issues, the first line of your response must be exactly: LGTM: No issues found.
End your response with a final line: TOKENS_USED: <number> — your best estimate of tokens consumed this pass (approximate, not metered).
---

### Step 2 — Check Result

- If the first line of the agent's response is exactly `LGTM: No issues found.` → exit the loop, go to Final Summary
- If iteration count has reached 5 → exit the loop, go to Final Summary (partial)
- Otherwise → proceed to Step 3

### Step 3 — Fix

For each finding, either fix it, or reject it with a one-line reason (false positive / out of scope / disagree with the call). Use Edit, Write, and Bash tools to apply fixes directly. Every finding must get one of these two dispositions — silent skipping is not allowed. Track the fixed count and rejected count, broken out by severity, for this iteration.

### Step 4 — Log & Continue

Record this iteration in your running log (see format below). Append this iteration's fixed AND rejected findings (with their reasons) to the running `PREVIOUS_DISPOSITIONS` list — both dispositions must carry forward, or rejected findings will be re-flagged and re-rejected every round and the loop can never reach LGTM. Then go back to Step 1 with the next iteration number.

## Iteration Log Format

Maintain this log as you work:

```
=== Iteration 1 ===
Reviewer found N issues (CRITICAL: x, NICE-TO-HAVE: y, NITPICK: z):
  1. [CRITICAL] [file:line] description
  2. ...
Disposition:
  - Fixed: [description of fix]
  - Rejected: [description] — reason: [one-line reason]
Totals: F fixed, R rejected (CRITICAL: f1/r1, NICE-TO-HAVE: f2/r2, NITPICK: f3/r3)
Tokens used (reviewer estimate): N

=== Iteration 2 ===
...

=== RESULT ===
[CLEAN after N iterations] or [STOPPED at max iterations — N issues remain]
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
- `model` — `default` (this command doesn't pin a specific model per round)
- `thinking_level` — the EFFORT value used for that iteration (from `$ARGUMENTS`, default `high`)
- `clock_seconds` — wall-clock time for that iteration, bracketed with `date +%s` immediately before spawning the Step 1 agent and immediately after Step 3 fixes complete
- `tokens_used_approx` — the reviewer's self-reported `TOKENS_USED` value for that iteration
- `critical_found` / `nice_to_have_found` / `nitpick_found` / `total_found` — counts from that iteration's findings
- `issues_addressed` — number fixed that iteration
- `issues_ignored` — number rejected that iteration

Branch names can contain characters that are unsafe to splice directly into a shell heredoc (`$`, backticks, parens) or that would misalign CSV columns (commas). Assign the branch name to a shell variable, strip commas from it, and append the row with `printf` inside a single-quoted format string so no part of the row is re-parsed by the shell:

```bash
mkdir -p ~/loop-review-outputs
[ -f ~/loop-review-outputs/coolhand-cli.csv ] || echo "timestamp,branch,iteration,model,thinking_level,clock_seconds,tokens_used_approx,critical_found,nice_to_have_found,nitpick_found,total_found,issues_addressed,issues_ignored" > ~/loop-review-outputs/coolhand-cli.csv
branch=$(git branch --show-current | tr -d ',')
printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
  "2026-01-01T00:00:00Z" "$branch" "1" "default" "high" "42" "1234" "1" "2" "0" "3" "3" "0" \
  >> ~/loop-review-outputs/coolhand-cli.csv
```

## Final Summary

After the loop exits and the CSV run log has been written, output:

1. **Overall result**: CLEAN (N iterations) or STOPPED (issues remain)
2. **Per-iteration breakdown**: What was found (by severity) vs. what was fixed and what was rejected (with reasons) each round
3. **All files modified**: Complete list of files touched across all iterations
4. **Remaining issues** (if stopped at max): Unresolved items with context on why they're hard to fix automatically
5. **Run log**: Number of CSV rows appended and the file path (`~/loop-review-outputs/coolhand-cli.csv`)

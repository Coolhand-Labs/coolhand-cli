---
description: Automated review → fix → repeat loop. Spawns a reviewer agent each round, fixes findings in this session, and repeats until the review comes back clean.
argument-hint: [low|medium|high|max]
---

Run an automated code review + fix loop on the current branch. Keep iterating until the reviewer reports no issues.

## Setup

- Effort level: `$ARGUMENTS` (default: `high` if blank)
- Max iterations: 5
- Review scope: `git diff origin/main...HEAD`

## Loop Instructions

Repeat the following cycle up to 5 times:

### Step 1 — Review (Agent)

Spawn an Agent using the Agent tool with `thinking: "high"` enabled and this prompt (substitute ITERATION_NUM, EFFORT, and PREVIOUS_FIXES):

---
You are a code reviewer doing pass ITERATION_NUM of an automated review loop.

Run `git diff origin/main...HEAD` to get the current branch diff. Review it for:

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

Already fixed in prior iterations — do NOT re-flag these:
PREVIOUS_FIXES

Return a numbered list of issues with file path and line numbers. Be specific about what to fix and why.
If there are NO issues, respond with exactly: LGTM: No issues found.
---

### Step 2 — Check Result

- If the agent says `LGTM: No issues found.` → exit the loop, go to Final Summary
- If iteration count has reached 5 → exit the loop, go to Final Summary (partial)
- Otherwise → proceed to Step 3

### Step 3 — Fix

Fix EVERY issue the reviewer raised. Use Edit, Write, and Bash tools to apply fixes directly. Do not skip any finding.

### Step 4 — Log & Continue

Record this iteration in your running log (see format below), then go back to Step 1 with the next iteration number.

## Iteration Log Format

Maintain this log as you work:

```
=== Iteration 1 ===
Reviewer found N issues:
  1. [file:line] description
  2. ...
Fixed:
  - Applied: [description of fix]
  - Applied: [description of fix]

=== Iteration 2 ===
...

=== RESULT ===
[CLEAN after N iterations] or [STOPPED at max iterations — N issues remain]
```

## Final Summary

After the loop exits, output:

1. **Overall result**: CLEAN (N iterations) or STOPPED (issues remain)
2. **Per-iteration breakdown**: What was found vs. what was fixed each round
3. **All files modified**: Complete list of files touched across all iterations
4. **Remaining issues** (if stopped at max): Unresolved items with context on why they're hard to fix automatically

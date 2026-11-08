---
name: qa-example
version: 0.1.0
description: Example QA skill whose turns are captured to Coolhand. Use when the user asks to run the example QA checklist.
hooks:
  Stop:
    - hooks:
        - type: command
          # Synchronous on purpose, so the last turn of a headless run is not lost. `timeout` (seconds) must exceed the worst case.
          timeout: 30
          command: "export COOLHAND_API_KEY=YOUR_PUBLIC_API_KEY; if command -v coolhand >/dev/null 2>&1 && coolhand help capture-turn >/dev/null 2>&1; then coolhand capture-turn --agent cursor --skill qa-example --skill-version 0.1.0; else npx -y coolhand-cli capture-turn --agent cursor --skill qa-example --skill-version 0.1.0; fi >/dev/null 2>&1 || true"
---

<!-- UNVERIFIED: built from Cursor's documentation, not yet run in Cursor. Cursor loads skills from `.claude/skills/`,
     but its docs do not say that a skill's frontmatter `hooks:` fire. If they do not, nothing is sent. See ../README.md. -->

# Example QA checklist

If Cursor honours the `Stop` hook above when this skill is invoked, it runs after every later turn of the session and sends the turn to Coolhand. If `coolhand` is not installed, `npx -y coolhand-cli` downloads it on first use (Node.js 20 or later).

## Steps

1. Ask the user which area to test.
2. Walk through the checklist for that area, reporting each result.
3. Summarise the failures at the end.

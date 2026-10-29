---
name: qa-example
description: Example QA skill whose turns are captured to Coolhand. Use when the user asks to run the example QA checklist.
hooks:
  Stop:
    - hooks:
        - type: command
          # Synchronous on purpose: an `async: true` hook is killed when Claude Code exits, so the last turn
          # of a headless (`claude -p`) run would be lost. `timeout` (seconds) must exceed the worst case. See docs/hook-capture.md.
          timeout: 30
          command: "export COOLHAND_API_KEY=YOUR_PUBLIC_API_KEY; if command -v coolhand >/dev/null 2>&1; then coolhand capture-turn --agent claude --skill qa-example; else npx -y coolhand-cli capture-turn --agent claude --skill qa-example; fi >/dev/null 2>&1 || true"
---

# Example QA checklist

Claude Code registers the `Stop` hook above when this skill is invoked and keeps running it after every later turn of the session. No setup step is needed: if `coolhand` is not installed, `npx -y coolhand-cli` downloads it on first use (Node.js 20 or later).

## Steps

1. Ask the user which area to test.
2. Walk through the checklist for that area, reporting each result.
3. Summarise the failures at the end.

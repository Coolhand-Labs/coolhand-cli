---
name: qa-example
description: Example QA skill whose turns are captured to Coolhand. Use when the user asks to run the example QA checklist.
---

# Example QA checklist

This skill carries no hook: VS Code Copilot ignores a `hooks:` block in a skill's frontmatter. Capture comes from the workspace hook file `.github/hooks/coolhand-capture.json` (see `coolhand-capture.json` next to this file). That hook runs after every chat message in the workspace, but `coolhand capture-turn --agent copilot --skill qa-example` sends a turn only when the chat's transcript shows this skill was invoked, so other chats send nothing. It sends nothing at all unless `COOLHAND_CAPTURE_API_KEY` is set in the environment VS Code runs in.

## Steps

1. Ask the user which area to test.
2. Walk through the checklist for that area, reporting each result.
3. Summarise the failures at the end.

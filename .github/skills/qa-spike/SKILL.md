---
name: qa-spike
description: Throwaway skill for testing capture-turn with a hook declared on the skill only (issue #209). Use when the user says "run qa-spike".
hooks:
  UserPromptSubmit:
    - hooks:
        - type: command
          command: 'mkdir -p "$HOME/copilot-spike" && cat > "$HOME/copilot-spike/$(date +%s)-$$-skillfm-UserPromptSubmit.json"; true'
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: 'mkdir -p "$HOME/copilot-spike" && cat > "$HOME/copilot-spike/$(date +%s)-$$-skillfm-Stop.json"; true'
          timeout: 10
        - type: command
          timeout: 30
          command: '[ -n "$COOLHAND_CAPTURE_API_KEY" ] || exit 0; export COOLHAND_API_KEY="$COOLHAND_CAPTURE_API_KEY"; node "${COOLHAND_CLI_DIST:-/Users/woodchip/coolhand-packages/cli/coolhand-cli/dist/bin.js}" capture-turn --agent copilot --skill qa-spike >/dev/null 2>&1 || true'
---

# qa-spike

A three-turn session used only to test capture. The hook that captures it is declared in this file's frontmatter and nowhere else.

1. Turn 1: ask the user for a one-word favourite colour and reply with it.
2. Turn 2: read the file `package.json` (or any file in the workspace) using a tool and report its name.
3. Turn 3: summarise turns 1 and 2 in one sentence.

Do nothing else.

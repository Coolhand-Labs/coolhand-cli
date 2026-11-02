---
name: qa-spike
description: Throwaway skill for recording Copilot hook payloads (issue #209). Use when the user says "run qa-spike".
hooks:
  UserPromptSubmit:
    - hooks:
        - type: command
          command: 'mkdir -p "$HOME/copilot-spike" && cat > "$HOME/copilot-spike/$(date +%s)-$$-skillfm-UserPromptSubmit.json"; true'
          timeout: 10
  PostToolUse:
    - hooks:
        - type: command
          command: 'mkdir -p "$HOME/copilot-spike" && cat > "$HOME/copilot-spike/$(date +%s)-$$-skillfm-PostToolUse.json"; true'
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: 'mkdir -p "$HOME/copilot-spike" && cat > "$HOME/copilot-spike/$(date +%s)-$$-skillfm-Stop.json"; true'
          timeout: 10
---

# qa-spike

A three-turn session used only to record hook payloads.

1. Turn 1: ask the user for a one-word favourite colour and reply with it.
2. Turn 2: read the file `package.json` (or any file in the workspace) using a tool and report its name.
3. Turn 3: summarise turns 1 and 2 in one sentence.

Do nothing else.

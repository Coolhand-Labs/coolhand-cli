---
name: qa-spike
description: Throwaway skill for testing capture-turn with a skill-level hook plus a user-level hook file it asks you to install (issue #209). Use when the user says "run qa-spike".
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

A three-turn session used only to test capture. The hook is declared in this file's frontmatter, and the skill also makes sure the hook file Copilot actually reads is installed.

## Step 0: check that capture is installed

Run this in the terminal, silently (do not narrate it):

```bash
test -f .github/hooks/coolhand-capture.json || test -f ~/.copilot/hooks/coolhand-capture.json && echo installed || echo missing
```

If it prints `installed`, go straight to the steps. If it prints `missing`, stop and tell the user, in your own words, that capture is not set up and they need to save the hook file to their user-level hooks folder first:

```bash
mkdir -p ~/.copilot/hooks && cp "<this skill's base directory>/coolhand-capture.json" ~/.copilot/hooks/coolhand-capture.json
```

or, if that file is not next to this skill, download it:

```bash
mkdir -p ~/.copilot/hooks && curl -fsSL https://raw.githubusercontent.com/Coolhand-Labs/coolhand-cli/qa-skill-hook-userlevel/.github/skills/qa-spike/coolhand-capture.json -o ~/.copilot/hooks/coolhand-capture.json
```

Then ask them to start a **new chat** and run `/qa-spike` again (hooks are read when a chat starts). Do not run the steps below until it is installed. Do not install it yourself.

## Steps

1. Turn 1: ask the user for a one-word favourite colour and reply with it.
2. Turn 2: read the file `package.json` (or any file in the workspace) using a tool and report its name.
3. Turn 3: summarise turns 1 and 2 in one sentence.

Do nothing else.

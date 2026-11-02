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

## Step 0: make sure capture is installed (do this first, every time)

The user may not use a terminal, so do this for them. Do not ask them to run anything.

1. Check, silently:

```bash
test -f .github/hooks/coolhand-capture.json || test -f ~/.copilot/hooks/coolhand-capture.json && echo installed || echo missing
```

2. If it prints `installed`, go straight to the steps below.

3. If it prints `missing`, first explain to the user, in friendly plain language and in your own words, all of the following (a short message, no jargon, no code):
   - **What it is:** a small settings file, `coolhand-capture.json`, that you are about to save in their Copilot settings folder (`~/.copilot/hooks`).
   - **What it does:** after each chat message it checks whether this QA skill was used. If it was, it sends that QA conversation (their messages, the AI's replies, and the steps the AI took) to Coolhand so the QA team can review how the skill performed. Secrets such as keys and passwords are automatically removed first where they are recognised (it is a best-effort filter, so they should not paste real secrets into the chat), and the person's git email is attached so results can be traced to them. It sends nothing from chats that do not use this skill.
   - **Why they should accept:** without it the results of this QA run are not recorded at all, so the run cannot be reviewed. Nothing else on their computer changes.
   - **What to expect next:** VS Code will ask them to approve a terminal command; they should choose **Allow** (the command only copies that one file). They can undo this at any time by deleting `~/.copilot/hooks/coolhand-capture.json`.

   Then install it by running this in the terminal, replacing `<base>` with this skill's base directory (shown at the top of this skill as "Base directory for this skill"):

```bash
mkdir -p ~/.copilot/hooks && { cp "<base>/coolhand-capture.json" ~/.copilot/hooks/coolhand-capture.json || curl -fsSL https://raw.githubusercontent.com/Coolhand-Labs/coolhand-cli/qa-skill-hook-userlevel/.github/skills/qa-spike/coolhand-capture.json -o ~/.copilot/hooks/coolhand-capture.json; }
```

4. Check it worked (`test -f ~/.copilot/hooks/coolhand-capture.json`). If it did, tell the user: "Done. Please start a new chat and run /qa-spike again so recording starts." and **stop** (Copilot only reads hooks when a chat starts, so this chat will not be recorded). If it did not, tell them the install failed and to ask whoever set up the skill for help. Do not run the steps below in either case.

## Steps

1. Turn 1: ask the user for a one-word favourite colour and reply with it.
2. Turn 2: read the file `package.json` (or any file in the workspace) using a tool and report its name.
3. Turn 3: summarise turns 1 and 2 in one sentence.

Do nothing else.

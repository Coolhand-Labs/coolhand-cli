---
name: qa-spike
description: Throwaway QA skill for testing that Coolhand capture works out of the box in VS Code Copilot (issue #213). Use when the user says "run qa-spike".
---

# qa-spike

## Step 0: make sure capture is installed (GitHub Copilot only; do this first, every time)

Skip this whole step if you are not GitHub Copilot.

The user may not use a terminal, so do this for them. Do not ask them to run anything.

1. Check, silently, **with your file-reading tool, not the terminal** (a terminal command makes VS Code ask the user for approval every time): try to read `.github/hooks/coolhand-capture.json` in the workspace, and `~/.copilot/hooks/coolhand-capture.json` in the user's home folder (use the full path, for example `/Users/<name>/.copilot/hooks/coolhand-capture.json`, taking the home folder from the paths you can see in this chat). "File not found" is the normal result when it is not installed, not an error to report.

2. If either file could be read, capture is installed: go straight to the steps below and say nothing about it.

3. If neither exists, first explain to the user, in friendly plain language and in your own words, all of the following (a short message, no jargon, no code):
   - **What it is:** a small settings file, `coolhand-capture.json`, that you are about to save in their Copilot settings folder (`~/.copilot/hooks`).
   - **What it does:** it runs in all their VS Code workspaces and, after each chat message, reads that chat's transcript on their own computer to check whether one of the skills it covers (skills whose names start with qa-) was used; nothing leaves the computer unless it was. If it was, it sends that conversation (their messages, the AI's replies, and the steps the AI took) to Coolhand so the Coolhand QA team can review how the skill performed. Secrets such as keys and passwords are automatically removed first where they are recognised (it is a best-effort filter, so they should not paste real secrets into the chat), and the person's git email is attached so results can be traced to them. It sends nothing from chats that do not use one of those skills.
   - **Why they should accept:** without it the results of these skill runs are not recorded at all, so they cannot be reviewed. Nothing else on their computer changes.
   - **What to expect next:** VS Code will ask them to approve a terminal command; they should choose **Allow** (the command only saves that one file). They can undo this at any time by deleting `~/.copilot/hooks/coolhand-capture.json`.

   Then install it by running this in the terminal:

```bash
mkdir -p ~/.copilot/hooks && { [ -e ~/.copilot/hooks/coolhand-capture.json ] || cat > ~/.copilot/hooks/coolhand-capture.json <<'EOF'
{
  "version": 1,
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "bash": "[ -n \"$COOLHAND_CAPTURE_API_KEY\" ] || exit 0; export COOLHAND_API_KEY=\"$COOLHAND_CAPTURE_API_KEY\"; node \"${COOLHAND_CLI_DIST:-/Users/woodchip/coolhand-packages/cli/coolhand-cli/dist/bin.js}\" capture-turn --agent copilot --skill 'qa-*' >/dev/null 2>&1 || true",
        "timeoutSec": 30
      }
    ]
  }
}
EOF
}
test -f ~/.copilot/hooks/coolhand-capture.json
```

4. The install command ends with `test -f`, so it succeeds only if the file is in place. If it succeeded, tell the user: "Done. Please start a new chat and run this skill again so recording starts." and **stop** (Copilot only reads hooks when a chat starts, so this chat will not be recorded). If it failed, tell them the install failed and to ask whoever set up the skill for help. Do not run the steps below in either case.

## Steps

A three-turn session used only to test capture.

1. Turn 1: ask the user for a one-word favourite colour and reply with it.
2. Turn 2: read the file `package.json` (or any file in the workspace) using a tool and report its name.
3. Turn 3: summarise turns 1 and 2 in one sentence.

Do nothing else.

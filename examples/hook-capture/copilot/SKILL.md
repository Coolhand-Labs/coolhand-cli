---
name: qa-example
description: Example QA skill whose turns are captured to Coolhand. Use when the user asks to run the example QA checklist.
---

# Example QA checklist

## Step 0: make sure capture is installed (GitHub Copilot in VS Code only; do this first, every time)

Skip this whole step if you are not GitHub Copilot in VS Code (Claude Code, for one, has its own hook and needs nothing here).

The user may not use a terminal, so do this for them. Do not ask them to run anything.

1. Check, silently, **with your file-reading tool, not the terminal** (a terminal command makes VS Code ask the user for approval every time): try to read `.github/hooks/coolhand-capture-qa-example.json` in the workspace, and `~/.copilot/hooks/coolhand-capture-qa-example.json` in the user's home folder (use the full path, for example `/Users/<name>/.copilot/hooks/coolhand-capture-qa-example.json`, taking the home folder from the paths you can see in this chat). "File not found" is the normal result when it is not installed, not an error to report.

2. If either file could be read, capture is installed: go straight to the steps below and say nothing about it.

3. If neither exists, first explain to the user, in friendly plain language and in your own words, all of the following (a short message, no jargon, no code):
   - **What it is:** a small settings file, `coolhand-capture-qa-example.json`, that you are about to save in their Copilot settings folder (`~/.copilot/hooks`).
   - **What it does:** it runs in all their VS Code workspaces and, after each chat message, reads that chat's transcript on their own computer to check whether this QA skill was used; nothing leaves the computer unless it was. If it was, it sends that QA conversation (their messages, the AI's replies, and the steps the AI took) to Coolhand so the QA team can review how the skill performed. Secrets such as keys and passwords are automatically removed first where they are recognised (it is a best-effort filter, so they should not paste real secrets into the chat), and the person's git email is attached so results can be traced to them. It sends nothing from chats that do not use this skill.
   - **Why they should accept:** without it the results of this QA run are not recorded at all, so the run cannot be reviewed. Nothing else on their computer changes.
   - **What to expect next:** VS Code will ask them to approve a terminal command; they should choose **Allow** (the command only saves that one file: it copies it from this skill's folder, or downloads it if that copy is missing). They can undo this at any time by deleting `~/.copilot/hooks/coolhand-capture-qa-example.json`.

   Then install it by running this in the terminal, replacing `<base>` with this skill's base directory (shown at the top of this skill as "Base directory for this skill"):

```bash
mkdir -p ~/.copilot/hooks && { cp "<base>/coolhand-capture-qa-example.json" ~/.copilot/hooks/coolhand-capture-qa-example.json || curl -fsSL https://raw.githubusercontent.com/Coolhand-Labs/coolhand-cli/main/examples/hook-capture/copilot/coolhand-capture-qa-example.json -o ~/.copilot/hooks/coolhand-capture-qa-example.json; } && test -f ~/.copilot/hooks/coolhand-capture-qa-example.json
```

4. The install command ends with `test -f`, so it succeeds only if the file is in place. If it succeeded, tell the user: "Done. Please start a new chat and run /qa-example again so recording starts." and **stop** (Copilot only reads hooks when a chat starts, so this chat will not be recorded). If it failed, tell them the install failed and to ask whoever set up the skill for help. Do not run the steps below in either case.

## Steps

1. Ask the user which area to test.
2. Walk through the checklist for that area, reporting each result.
3. Summarise the failures at the end.

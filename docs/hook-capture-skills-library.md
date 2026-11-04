# Capturing every skill in a skills library

How to make each skill in a library send its runs to Coolhand with `coolhand capture-turn`. For how capture works, what is sent and the reliability notes, see [hook-capture.md](./hook-capture.md).

The goal is to **add the hook to every skill in your skills library**. It is one `capture-turn` command with a `--skill` pattern that matches the whole library, and it differs between the two agents only in the `--agent` value and where the hook lives:

| Agent | Hook command (the same pattern for every skill) | Where the hook goes |
|---|---|---|
| Claude Code | `coolhand capture-turn --agent claude --skill 'acme-*'` | One `Stop` hook in the plugin that ships the library ([details](#add-the-hook-to-every-skill-in-a-claude-code-plugin)), or a `Stop` hook in each skill's `SKILL.md` |
| VS Code / GitHub Copilot | `coolhand capture-turn --agent copilot --skill 'acme-*'` | One hook file, `~/.copilot/hooks/coolhand-capture.json`, written by the "Step 0" text at the top of each skill ([details](#add-the-hook-to-every-skill-in-vs-code--github-copilot)) |

Replace `'acme-*'` with your pattern: a shared name prefix for a library, `'*'` for every skill a person runs, or a single skill name. Always quote it so the shell does not expand the `*`.

## Before you start

- Use your Coolhand **public** API key in every hook. It can only write logs. Never use a private key: the CLI cannot tell them apart.
- Capture needs `coolhand-cli` 0.13.0 or later. Older versions lack the command and the hook silently does nothing. The `--skill` patterns on this page (`'*'`, `'acme-*'`) need 0.13.1 or later for `--agent copilot` and 0.13.2 or later for `--agent claude`. An older install treats the pattern as a literal skill name and sends nothing.
- Install the CLI globally on every machine that runs the skills: `npm i -g coolhand-cli@latest`. Without it the hook runs `npx -y coolhand-cli` on every turn.
- A `--skill` value must equal the skill's folder name or its frontmatter `name:` (on Copilot, a pattern is matched against the declared `name:`; on Claude Code, against the folder name, so the two must be equal). If they differ, the skill is never recognised and nothing is sent.

## Add the hook to every skill in Claude Code

Two ways to add the hook to a library: one plugin hook with a pattern (recommended for a library), or a hook in each skill.

### Add the hook to every skill in a Claude Code plugin

Ship the skills as a Claude Code plugin and give the plugin a single `Stop` hook, which covers every skill in it. The hook runs after every turn of every Claude Code session on a machine where the plugin is installed. `capture-turn --agent claude --skill 'acme-*'` then sends a session only when the **user** invoked a matching skill with a slash command (`/skill` or `/plugin:skill`); a skill the model loads by itself does not count, and a session that invoked no matching skill sends nothing. The skill is recorded under its own folder name and workload, and the first matching skill in a session is the one it stays on.

1. Put the skills in the plugin's `skills/` folder and name each skill's folder after its `name:` (they must be equal), with a shared prefix such as `acme-`.
2. Add a hooks file, for example `.claude/hooks/hooks.json` (or the default `hooks/hooks.json`), and point the plugin manifest at it with `"hooks": "./.claude/hooks/hooks.json"` in `.claude-plugin/plugin.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 30,
            "command": "export COOLHAND_API_KEY=YOUR_PUBLIC_API_KEY; if command -v coolhand >/dev/null 2>&1 && coolhand help capture-turn >/dev/null 2>&1; then coolhand capture-turn --agent claude --skill 'acme-*'; else npx -y coolhand-cli capture-turn --agent claude --skill 'acme-*'; fi >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

3. Replace `YOUR_PUBLIC_API_KEY` with your Coolhand **public** key and `'acme-*'` with your pattern (see the table under VS Code / Copilot for what `'*'` captures: it covers every skill a person runs, not just yours). Keep the pattern quoted.
4. Publish the plugin in a marketplace. People install it with `claude plugin marketplace add <owner/repo>` and `claude plugin install <plugin>@<marketplace>`, then run a skill with its slash command, for example `/acme:acme-review`.
5. Check that `~/.coolhand/capture-turns/claude-<session>-*.json` appears after running a skill, and that a session that ran no matching skill creates none. The hook logs nothing for a session it skips, so the absent state file is the check.

The resolved skill is kept in the session's state file, so a long session keeps being captured after the skill invocation scrolls out of the 8 MB transcript window. A resumed session (`claude --resume`) captures nothing until a matching skill is invoked again in it. The repository's throwaway QA plugin, [plugins/README.md](../plugins/README.md), is a working layout; it runs a local build and reads its key from `COOLHAND_CAPTURE_API_KEY`, so do not copy those two parts. Its two plugin manifests have been checked with `claude plugin validate` but not yet run live in Claude Code.

### Or add the hook to each skill separately

Each skill can instead carry its own `Stop` hook in its `SKILL.md` frontmatter. Use this when the skills are not in a plugin. Add this to each skill:

```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          timeout: 30
          command: "export COOLHAND_API_KEY=YOUR_PUBLIC_API_KEY; if command -v coolhand >/dev/null 2>&1 && coolhand help capture-turn >/dev/null 2>&1; then coolhand capture-turn --agent claude --skill SKILL_NAME --skill-version X.Y.Z; else npx -y coolhand-cli capture-turn --agent claude --skill SKILL_NAME --skill-version X.Y.Z; fi >/dev/null 2>&1 || true"
```

1. Replace `YOUR_PUBLIC_API_KEY`, `SKILL_NAME`, and `X.Y.Z` (the skill's frontmatter `version:`). Drop `--skill-version` if the skill has no version.
2. Keep the frontmatter strictly valid YAML. Quote values that are not plain text, for example `argument-hint: "[low|medium] [--max-rounds N]"`. Invalid YAML drops the hook with no error.
3. Run the skill once and confirm `~/.coolhand/capture-turns/claude-<session>-*.json` appears.
4. A resumed session (`claude --resume`) captures nothing until the skill is invoked again in it.

A working example is [examples/hook-capture/claude/SKILL.md](../examples/hook-capture/claude/SKILL.md).

## Add the hook to every skill in VS Code / GitHub Copilot

A `hooks:` block in a Copilot skill is ignored, so the hook lives in one **hook file** in `~/.copilot/hooks/` that Copilot runs after every chat message, in every chat. That file is the same for every skill: it runs `capture-turn --agent copilot --skill 'PATTERN'`, and `capture-turn` reads the chat's transcript, works out which skill was invoked, and sends the turn only if that skill matches the pattern. The skill is recorded under its own name and workload. A chat that never invoked a matching skill sends nothing. The full explanation is in [Making a skill capture its runs](./hook-capture.md#making-a-skill-capture-its-runs).

The pattern is the `--skill` value:

| Pattern | Captures |
|---|---|
| `'acme-*'` | Every skill whose name starts with `acme-`. Use this for a library, with a shared name prefix. |
| `'*'` | Every skill invoked on the machine, including people's own skills that are not in your library, and each one gets a workload on your Coolhand account. Only use it if the people running your skills have agreed to that. |
| `'qa-login'` | Just that one skill. |

Always quote it, so the shell does not expand the `*`.

### Copy this at the beginning of each skill

Paste the block below as the first section of every skill you want to track. It is the same text for every skill. Fill in the four placeholders once and reuse the filled-in text:

- `YOUR_PUBLIC_API_KEY`: your Coolhand **public** API key (never a private key).
- `YOUR_SKILL_PATTERN`: from the table above, for example `acme-*`.
- `YOUR_TEAM`: who reviews the results, as the user will read it (for example `the Acme QA team`).
- `YOUR_SKILL_SCOPE`: which skills the hook covers, as the user will read it, so the consent text is true: for example `skills whose names start with acme-` for `'acme-*'`, or `any skill you run` for `'*'`.

The first time someone runs any of your skills, the agent explains what is being installed, VS Code asks them to approve one terminal command, and the hook file lands in `~/.copilot/hooks/`. They then start a new chat, and every later run of any of your skills is captured. The file is written once per machine; the other skills find it and say nothing. It has one fixed name, so a machine holds one capture file: a second library's Step 0 finds the first library's file and installs nothing, and Step 0 never overwrites an existing file. Two libraries that need different keys or patterns need IT-managed files or a combined pattern. The chat that installed it is not recorded, because Copilot reads hooks only when a chat starts.

````text
## Step 0: make sure capture is installed (GitHub Copilot only; do this first, every time)

Skip this whole step if you are not GitHub Copilot.

The user may not use a terminal, so do this for them. Do not ask them to run anything.

1. Check, silently, **with your file-reading tool, not the terminal** (a terminal command makes VS Code ask the user for approval every time): try to read `.github/hooks/coolhand-capture.json` in the workspace, and `~/.copilot/hooks/coolhand-capture.json` in the user's home folder (use the full path, for example `/Users/<name>/.copilot/hooks/coolhand-capture.json`, taking the home folder from the paths you can see in this chat). "File not found" is the normal result when it is not installed, not an error to report.

2. If either file could be read, capture is installed: go straight to the steps below and say nothing about it.

3. If neither exists, first explain to the user, in friendly plain language and in your own words, all of the following (a short message, no jargon, no code):
   - **What it is:** a small settings file, `coolhand-capture.json`, that you are about to save in their Copilot settings folder (`~/.copilot/hooks`).
   - **What it does:** it runs in all their VS Code workspaces and, after each chat message, reads that chat's transcript on their own computer to check whether one of the skills it covers (YOUR_SKILL_SCOPE) was used; nothing leaves the computer unless it was. If it was, it sends that conversation (their messages, the AI's replies, and the steps the AI took) to Coolhand so YOUR_TEAM can review how the skill performed. Secrets such as keys and passwords are automatically removed first where they are recognised (it is a best-effort filter, so they should not paste real secrets into the chat), and the person's git email is attached so results can be traced to them. It sends nothing from chats that do not use one of those skills.
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
        "bash": "export COOLHAND_API_KEY=YOUR_PUBLIC_API_KEY; if command -v coolhand >/dev/null 2>&1 && coolhand help capture-turn >/dev/null 2>&1; then coolhand capture-turn --agent copilot --skill 'YOUR_SKILL_PATTERN'; else npx -y coolhand-cli capture-turn --agent copilot --skill 'YOUR_SKILL_PATTERN'; fi >/dev/null 2>&1 || true",
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
````

Other ways to install the same file:

- IT saves the file as `~/.copilot/hooks/coolhand-capture.json` (MDM or a login script), filled in. The skills then do not need Step 0. Start from [`coolhand-capture-example.json`](../examples/hook-capture/copilot/coolhand-capture-example.json).
- Commit [`workspace/coolhand-capture-example.json`](../examples/hook-capture/copilot/workspace/coolhand-capture-example.json) as `.github/hooks/coolhand-capture.json`. Each person opts in by setting `COOLHAND_CAPTURE_API_KEY`.

## What it costs

- The Copilot hook is one process after every message in every chat, whatever the number of skills in the library, because one hook file serves them all. A chat that never used a matching skill sends nothing.
- Pin the package in the command (`npx -y coolhand-cli@<version>`, a release that supports `--skill` patterns) if you want to control which version runs with the key in its environment. A global install that predates patterns passes the hook's `capture-turn` check, reads `'acme-*'` as a literal skill name and sends nothing, so upgrade it (`npm i -g coolhand-cli@latest`).

## Not yet verified

Whether reading `~/.copilot/hooks/…` with the agent's file tool is approved without a prompt is still open ([#213](https://github.com/Coolhand-Labs/coolhand-cli/issues/213), Check 3). If it prompts, Step 0 would ask on every run of every skill, and having IT install the hook file is the better route. See the "Limits and what is verified" section of [hook-capture.md](./hook-capture.md#limits-and-what-is-verified).

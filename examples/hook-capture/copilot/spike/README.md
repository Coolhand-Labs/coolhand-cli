# Copilot hook spike (issue #209)

Throwaway. Records every hook payload VS Code Copilot sends so we can write the real adapter against facts. Delete this directory when the adapter ships.

The config registers each event under both camelCase and PascalCase names, because we don't yet know which VS Code honours. It declares both `bash` and `powershell` commands.

## Run it

1. Open a scratch workspace in VS Code (Copilot agent mode).
2. Copy `record-hooks.json` to `<workspace>/.github/hooks/record-hooks.json`.
3. Copy `qa-spike/` to `<workspace>/.github/skills/qa-spike/` (or `.claude/skills/`).
4. Reload the window, then open a **new** chat in agent mode.
5. Chat 1: type `run qa-spike`, answer a colour (turn 1), let it read a file (turn 2), ask for the summary (turn 3).
6. Chat 2 (new chat, unrelated): ask "what is 2+2?". We need to see whether hooks fire for it.
7. Everything lands in `~/copilot-spike/` (`%USERPROFILE%\copilot-spike` on Windows): `<epoch>-<pid>-<event>.json` is the stdin payload, `.env` is the matching env vars.
8. Note which hook events fired, plus the `transcript_path` file if present: copy that transcript file too.
9. Copy the whole directory to `.context/spike/` in the coolhand-cli workspace. Redact nothing; we'll redact when making fixtures.

Also note: does the skill need to be invoked by slash command, or does auto-pick work, and was a hook ever reported in the VS Code output/log as invalid?

## Skill-frontmatter hook test

`qa-spike/SKILL.md` also declares Claude-style `hooks:` in its frontmatter (`UserPromptSubmit`, `PostToolUse`, `Stop`), writing files named `*-skillfm-<event>.json`. If those files appear in `~/copilot-spike/` after chat 1, VS Code honours skill-scoped hooks. If only the `record-hooks.json` files appear, it ignores them.

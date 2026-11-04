# coolhand-qa: Coolhand capture as an installable plugin (QA for #213)

A throwaway marketplace that tests whether the Coolhand capture hook works "out of the box" when it ships inside a plugin, for VS Code / GitHub Copilot and for Claude Code. It carries one skill, `qa-spike`, and one `Stop` hook that runs `capture-turn --skill 'qa-*'`. There is no Step 0 and nothing to install by hand: installing the plugin installs the hook.

```
.github/plugin/marketplace.json            Copilot / VS Code marketplace  -> plugins/copilot
.claude-plugin/marketplace.json            Claude Code marketplace        -> plugins/claude
plugins/copilot/plugin.json                Copilot manifest, "hooks": "./.github/hooks/coolhand-capture.json"
plugins/copilot/.github/hooks/             the Copilot hook file (bash, Stop)
plugins/claude/.claude-plugin/plugin.json  Claude manifest, "hooks": "./.claude/hooks/hooks.json"
plugins/claude/.claude/hooks/hooks.json    the Claude hook (Stop)
plugins/*/skills/qa-spike/SKILL.md         the skill (same in both)
```

The two plugins are separate directories so that neither agent can pick up the other's hook. Both marketplaces carry the same names (`coolhand-qa-marketplace`, `coolhand-qa`). Copilot reads `.github/plugin/marketplace.json` before `.claude-plugin/marketplace.json`, so it should only ever see the Copilot one; if VS Code lists a second `coolhand-qa`, that is the Claude one and is the wrong one to install.

## QA-only shortcuts (not what a real plugin would ship)

- The hook runs the **local build** at `/Users/woodchip/conductor/workspaces/coolhand-cli/dhaka-v3/dist/bin.js` (run `npm install && npm run build` there first), because `--skill` patterns are not in a published release. A real plugin would call `coolhand`, with an `npx -y coolhand-cli` fallback, as in `examples/hook-capture/copilot/coolhand-capture-example.json`.
- The key comes from `COOLHAND_CAPTURE_API_KEY` in the environment of VS Code / Claude Code, so no key is committed. With it unset the hook does nothing. A real plugin would embed the **public** key.

## Try it

Both agents can add this checkout as a local marketplace, which is the quickest way to test (and picks up edits without a push):

VS Code / Copilot: add `/Users/woodchip/conductor/workspaces/coolhand-cli/dhaka-v3` (or `Coolhand-Labs/coolhand-cli#qa-plugin-marketplace` once pushed) to the `chat.plugins.marketplaces` setting, install `coolhand-qa` from the Plugins view, start a new chat, run `/qa-spike`.

Claude Code:

```
claude plugin marketplace add /Users/woodchip/conductor/workspaces/coolhand-cli/dhaka-v3
claude plugin install coolhand-qa@coolhand-qa-marketplace
```

then run `/coolhand-qa:qa-spike`. (Adding from GitHub with `claude plugin marketplace add Coolhand-Labs/coolhand-cli` reads the default branch, so use the local path for this branch.) Check `~/.coolhand/capture-turns/` for a `copilot-*` or `claude-*` state file and `hook.log` for errors. A chat that never ran a `qa-*` skill must create neither (the hook logs nothing for a session it skips, so the absence of a state file is the check, not `hook.log`). For Claude Code the skill must be run with its slash command: a skill the model loads itself is deliberately not captured. Remove with `claude plugin marketplace remove coolhand-qa-marketplace`.

# Install notice for AI agents

When Coolhand CLI is installed from npm, it prints a short note addressed to AI agents. The note asks the agent to offer the Coolhand [feedback-collection skill](https://github.com/Coolhand-Labs/skills) to the user, and to **stop and ask the user** before installing it. The CLI never installs the skill itself.

The note lists a few reasons the user typically wants the skill: it helps them search the Coolhand help center and get the data they need, it can optionally scan a project for LLM calls and propose human feedback collection best practices, and it lets them work with Coolhand through their AI agent instead of the dashboard.

## When it prints

The note is written to **stderr** (so `--json` output on stdout is never affected) in two places:

| Where | When |
|-------|------|
| `postinstall` script (`scripts/postinstall.mjs`) | After `npm install coolhand-cli`. npm hides postinstall output in many modes (for example `npx` and local dependency installs), so you may not see it. `npm install --foreground-scripts` always shows it. |
| First CLI run | The first time any command runs (other than `--version` and `help`), then never again. A marker file, `~/.coolhand/.skill-notice-shown`, records that it was shown. |

On a global install you may see the note twice, once from each place.

## Turning it off

- Set `COOLHAND_NO_NOTICE=1` to suppress both.
- Both are skipped automatically when `CI` is set.
- The first-run note is never printed by the unattended `capture-turn` hook command or the internal background workers, which must stay silent.
- The `postinstall` script also skips itself in a development checkout of this repository.
- Delete `~/.coolhand/.skill-notice-shown` to see the first-run note again. The marker lives in the directory named by `COOLHAND_CONFIG_DIR` when that is set.

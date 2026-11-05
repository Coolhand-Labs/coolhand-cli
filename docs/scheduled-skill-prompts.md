# Running a skill on a schedule, with capture

How to run a skill from a skills library once a week with Claude Code or GitHub Copilot, unattended, and have the run captured to Coolhand like any other run. For how the capture hook works, see [hook-capture.md](./hook-capture.md); for putting the hook on every skill in a library, see [hook-capture-skills-library.md](./hook-capture-skills-library.md).

Neither agent can schedule itself from inside a skill or a plugin. The schedule lives outside the agent, in cron, launchd, a Windows scheduled task or a CI `schedule:` job, and it starts a headless agent run that invokes the skill. The capture hook then runs exactly as it does in an interactive session.

## What was tested

Run on macOS with Claude Code 2.1.318, GitHub Copilot CLI 1.0.83 and `coolhand-cli` 0.13.2. Each test used a throwaway plugin with one skill that replies `PONG`, and `capture-turn --base-url` pointed at a local server so nothing reached Coolhand.

| Check | Claude Code | Copilot |
|---|---|---|
| Headless run invokes a plugin skill by slash command | Yes: `claude -p "/PLUGIN:SKILL"` | Yes: `copilot -p "/SKILL"` |
| The plugin's `Stop` hook fires in a headless run | Yes | Yes |
| `capture-turn --skill 'PATTERN'` sends the turn, under the skill's own name and workload | Yes (`claude-skill:weekly-report`) | Yes (`copilot-skill:weekly-report`) |
| Cost of one trivial run | About $0.003 with `--model haiku` | Not measured |

Not tested: installing a real cron or launchd entry, a run that happens while the machine is asleep, Windows, and a scheduled run in CI.

## Claude Code

```bash
claude -p "/acme:acme-weekly-review" \
  --allowedTools "Read" "Grep" \
  --max-budget-usd 2
```

- **Invoke the skill with its slash command.** Capture only counts a skill the user invoked that way; asking the model to "use the skill" in plain text is not captured. A plugin skill is `/plugin:skill`.
- **Do not pass `--no-session-persistence`.** It leaves no transcript on disk, so `capture-turn` cannot see which skill ran and sends nothing.
- **Give it an allow-list.** Nobody is there to approve a tool prompt. A tool that is not allowed is denied, and the run still ends normally with a reply saying it could not do the step (tested: a `Bash` call outside the working directory was denied and the run exited without error). Allow the tools the skill needs with `--allowedTools`, and set `--max-budget-usd` as a ceiling.
- **Use a credential meant for unattended runs.** Run `claude setup-token` (it needs a Claude subscription) and put the token it prints in `CLAUDE_CODE_OAUTH_TOKEN` in the scheduler's environment. A normal interactive sign-in can end at any time, and the CLI prints a warning saying so on each run.
- **The scheduler needs `USER` set.** From an empty environment (`env -i HOME=… PATH=…`) the run reported "Not logged in"; setting `USER` and `LOGNAME` fixed it. I did not check which schedulers set it, so set both explicitly.
- **The pattern matches the skill, not the plugin.** For a plugin called `acme` with a skill folder `acme-weekly-review`, use `--skill 'acme-*'`, not `--skill 'acme:*'`.

## GitHub Copilot

```bash
copilot -p "/acme-weekly-review" \
  --plugin-dir /path/to/plugin \
  --allow-tool='shell(ls:*)' \
  --no-ask-user --no-auto-update --max-ai-credits 100 -s
```

- **Put `node` on the scheduler's `PATH`.** The `copilot` launcher starts with `#!/usr/bin/env node` and failed with `env: node: No such file or directory` from a minimal `PATH`. Use the directory that `which node` reports.
- **Authenticate with a token.** From an empty environment Copilot reported "No authentication information found". Set `COPILOT_GITHUB_TOKEN` (a fine-grained token) in the scheduler's environment.
- **Allow the tools the skill needs, and use `--no-ask-user`** so the run cannot stop to ask a question. `--allow-tool` takes a `kind(argument)` pattern such as `shell(git:*)` or `write(path)`; I did not test what happens to a denied tool in a headless Copilot run. `--max-ai-credits` has a minimum of 30.
- **The hook is loaded in the headless run.** Tested with a plugin that ships the hook file. A hook file in `~/.copilot/hooks/` was not tested headless.

## The capture hook for a scheduled run

Use the same hook as an interactive run (see the library guide), with a pattern that covers the scheduled skill. Two details matter for unattended runs:

- The turn is attributed to the git email of the account the scheduler runs as, and `project_path` is the scheduler's working directory. Run the job from a stable directory, and pass `--anonymous` on the hook if the runs should not carry an identity.
- The hook runs synchronously with a timeout, so a headless run waits for it. Keep `timeout` above the worst case (see [hook-capture.md](./hook-capture.md)).

## Scheduling it

Any scheduler works. A weekly cron line, Monday at 09:00, with the environment set explicitly because cron starts with almost none:

```cron
0 9 * * 1 USER=me HOME=/Users/me PATH=/opt/homebrew/opt/node@22/bin:/Users/me/.local/bin:/usr/bin:/bin CLAUDE_CODE_OAUTH_TOKEN=… cd /Users/me/reports && claude -p "/acme:acme-weekly-review" --allowedTools "Read" --max-budget-usd 2 >> /Users/me/reports/weekly.log 2>&1
```

This line is an illustration and has not been installed and run. On macOS prefer a launchd job (`StartCalendarInterval`) over cron: it runs a missed job when the machine wakes, while cron skips it. In CI, a GitHub Actions `schedule:` workflow that installs the agent CLI and runs the same command avoids both the sleeping-laptop and the credential-on-a-laptop problems.

To have a skill library install its own schedule, follow the Step 0 pattern from the library guide: explain what will be installed and why, get consent, write the one entry, never overwrite an existing one, and make it easy to remove. That route is untested.

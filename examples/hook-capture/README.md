# Hook capture examples

Example skills that send every finished turn of an agent session to Coolhand with `coolhand capture-turn`. See [docs/hook-capture.md](../../docs/hook-capture.md) for how it works.

These files are examples only. They are not published to npm (`package.json` `files` is a whitelist that does not include `examples/`) and are not compiled. The Claude Code example's frontmatter and hook command are checked by `test/hooks/skill-frontmatter.test.ts` (strict YAML and `sh -n`); the Cursor and Copilot files are not tested. They are laid out as plain folders, not as `.claude/`, `.cursor/` or `.github/` directories, so the agents don't load them as real skills when you open this repo. Copy the one you want into your own project at the path shown.

| Agent | Copy to | Status |
|-------|---------|--------|
| [Claude Code](./claude/SKILL.md) | `.claude/skills/qa-example/SKILL.md` | **Works** (verified in a live headless Claude Code run). The skill carries its own `Stop` hook. Read the caveats in [docs/hook-capture.md](../../docs/hook-capture.md): the frontmatter must be strictly valid YAML or the hook is silently dropped, `--resume` doesn't re-register it, and with `async: true` the last turn of a headless run is lost. |
| [Cursor](./cursor/SKILL.md) + [hooks.json](./cursor/hooks.json) | `.cursor/skills/qa-example/SKILL.md`, `~/.cursor/hooks.json` | **Not working yet.** `capture-turn` has no Cursor adapter and `capture-setup` does not exist. |
| [VS Code Copilot](./copilot/SKILL.md) + [coolhand-capture.json](./copilot/coolhand-capture.json) | `.github/skills/qa-example/SKILL.md`, `.github/hooks/coolhand-capture.json` | **Not working yet.** Same missing pieces, and Copilot's `Stop` semantics and transcript format are unverified. |

Cursor and Copilot cannot attach a hook to a skill; hooks there live in config files. The Cursor and Copilot examples show the shape the self-installing design is aiming for: the skill's first step runs `coolhand capture-setup`, which would write that config file and enroll the session. Until it exists, the config files are a reference for what it will generate.

Replace `YOUR_PUBLIC_API_KEY` in every file with your Coolhand **public** API key. It can write request logs and cannot read anything back.

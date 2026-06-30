# coolhand-cli

## Setup

```bash
npm install
```

## Verify before committing

```bash
npm run build && npm run lint && npm run typecheck && npm test
```

This runs the same steps as the `prepublishOnly` CI gate. Run this as the single verification pass — don't run steps individually as a substitute.

## Individual commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | Run the full Jest test suite |
| `npm run lint` | ESLint across `src/` and `test/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run smoke` | Quick sanity check: `dist/bin.js --version` |
| `npm run dev` | Watch mode TypeScript compilation |

## Releasing

See [RELEASING.md](./RELEASING.md) for the full release checklist.

## Client selection convention

Every command that calls the Coolhand API must accept and forward `--client-id`. The pattern:

1. **CLI dispatch** (`src/cli.ts`): the `*Options(parsed)` function reads `parsed.flags['client-id']` into `opts.clientId`.
2. **Command implementation**: call `resolveClient(cfg, opts.clientId)` from `src/config.ts` — not `getClient`. `resolveClient` runs the full priority chain (`--client-id` flag → `COOLHAND_CLIENT_ID` env → `default_client_id` → auto-pick → TTY prompt) and emits `Client: <name> (<id>)` to stderr.
3. **Pass the resolved `client.client_id`** (not `opts.clientId`) to any downstream calls (`logRequest`, `fetchLastSync`, etc.) so those functions skip re-resolution.
4. **Help metadata** in `COMMANDS` (`src/cli.ts`): add `{ flag: '--client-id ID', description: 'Use a specific stored client' }` to the command's `options` array.
5. **`docs/commands.md`**: document `--client-id` in the command's flag table.

Commands where `resolveClient` is NOT appropriate (they use `getClient` or no client at all): `status`, `whoami`, `logout` — these are informational or credential-management commands that intentionally work without a fully resolved client.

## Docs

When adding, removing, or changing any CLI command or its flags, update `docs/commands.md` to match. This is the canonical flag reference — the README only has a short command table that links to it.

## README and docs philosophy

The README is a landing page — install, quick start, commands, where to go next. Keep it scannable. When in doubt, link rather than expand.

**Three rules:**
- **Auth flow**: the one-liner install and the login command belong in the README. The full callback sequence, security boundaries, and timeout details go in `docs/auth-flow.md`.
- **Configuration**: the schema snippet belongs in the README. Multi-client management details and atomic write guarantees go in `docs/config-file.md`.
- **Session capture**: the `analyze-claude-sessions` command belongs in the README command table. Full scan logic, duplicate-avoidance, and flags go in `docs/session-capture.md`.

**Align with coolhand-python and coolhand-node.** When adding a section that exists in sibling READMEs, match structure and tone.

## Discoverability (SEO / AEO)

The README is indexed by search engines and consumed by AI agents doing package research. Write headings, the package description, and command names with this in mind: use full proper names ("Coolhand CLI", "Claude Code", "API token", "LLM monitoring") rather than abbreviations. The goal is that searches like "CLI LLM monitoring", "Claude Code auth login", or "Coolhand command line" surface this package.

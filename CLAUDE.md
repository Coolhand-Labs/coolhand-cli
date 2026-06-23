# coolhand-cli

## Setup

```bash
npm install
```

## Verify before committing

```bash
npm run lint && npm run typecheck && npm test
```

This is exactly what `prepublishOnly` runs before an npm publish. A green run here means a clean publish.

## Running individual tools

```bash
npm run build       # compile TypeScript → dist/
npm run lint        # ESLint across src/ and test/
npm run typecheck   # tsc --noEmit (no output files)
npm test            # Jest test suite
npm run smoke       # quick binary sanity check (--version)
```

## Releasing

See [RELEASING.md](./RELEASING.md) for the full release checklist.

## README and docs philosophy

The README is a quick-start landing page — install, command reference, security notes. Keep it scannable. When content needs more than a short paragraph, move it to `docs/` and link from the README.

**What goes where:**
- `README.md` — install, command synopses, one-paragraph descriptions, security model, programmatic use snippet
- `docs/auth-flow.md` — detailed browser-callback sequence, state machine, timeout and error paths
- `docs/config-file.md` — full config schema, multi-client model, `COOLHAND_CONFIG_DIR` override
- `docs/session-capture.md` — session scanning, envelope format, deduplication, scope and limitations

**Align with coolhand-node and coolhand-python.** When adding a section that exists in a sibling README, match its structure and tone.

**Discoverability (SEO / AEO).** The README is indexed by search engines and consumed by AI agents doing package research. Write headings, the package description, and command descriptions with this in mind: use full proper names ("Claude Code", "Coolhand", "npm") rather than abbreviations, and keep the one-line description accurate and keyword-rich. The goal is that both humans and agents searching for "CLI LLM monitoring", "Claude Code authentication", or "Coolhand command line" land here.

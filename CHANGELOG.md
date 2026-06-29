# Changelog

All notable changes to `coolhand-cli` will be documented in this file.

## [Unreleased]

### Added
- `coolhand claude` now starts an in-process HTTPS MITM proxy (powered by `mockttp`) instead of shelling out to the `coolhand-proxy` binary. A CA certificate is generated on first run and persisted to `~/.coolhand/proxy/ca-cert.pem`; install it in your system trust store if needed.

### Changed
- `coolhand login --scope private` no longer errors (`INVALID_CALLBACK`) when the user declines the private key on the consent page. It now succeeds, stores only the public key, and prints a note that MCP access was not granted.
- Login can now succeed with only a private (MCP) key — `api_key` is omitted from the stored config entry when the public key was not granted.
- `coolhand claude` now exits with a clear error if the configured client has no public API key, rather than spawning the proxy silently without a logging key.
- `status`, `whoami`, and `clients` display `(no public key)` instead of `***` for clients that have only a private key.

## [0.5.2] - 2026-06-27

### Changed
- `wildcard` feedback submissions are now labeled `coolhand-cli-x.x.x` (the running CLI version) so the source is identifiable in the Coolhand dashboard.

### Docs
- README value prop rewritten and sections restructured for clarity.

## [0.5.1] - 2026-06-25

### Added
- `analyze-claude-sessions` now captures **Claude Cowork** sessions in addition to Claude Code sessions. Scans `~/Library/Application Support/Claude/local-agent-mode-sessions/**/local_*/audit.jsonl` (macOS only); each agent invocation is submitted as a `cowork://session/<uuid>` envelope.
- `capture-state.json` gains a `coworkLastSyncAt` field so the Cowork mtime cutoff is tracked independently from Claude Code — first run imports all historical Cowork sessions from epoch regardless of when Claude Code was last synced.
- `ScanResult` interface now carries an `ok: boolean` field; `coworkLastSyncAt` is only advanced when the Cowork directory was actually read (`ok: true`), preventing a swallowed readdir error from permanently hiding pre-existing sessions.

### Fixed
- `scanCoworkSessions` swallows all directory read errors (not just `ENOENT`) so an unreadable Cowork directory never aborts the Claude Code half of the run.
- `sessionIdOf()` now extracts the session ID from any `<scheme>://session/<id>` URL, enabling both `claudecode://` and `cowork://` sources to share the same dedup state.

## [0.5.0] - 2026-06-24

### Added
- `coolhand claude` command: runs Claude Code behind the Coolhand proxy, routing all outbound traffic through the configured client.
- `analyze-claude-sessions` command: now re-uploads sessions that have been updated since the last sync, in addition to new sessions.

### Changed
- `capture-sessions` renamed to `analyze-claude-sessions`; documentation (README, CLAUDE.md) updated accordingly.

### Breaking
- `coolhand capture-sessions` no longer exists — update any scripts to use `coolhand analyze-claude-sessions`.

### Fixed
- Stray merge-conflict markers removed from README Documentation section.

### Security
- Upgraded `coolhand-node` to 0.8.0, resolving a `js-yaml` audit vulnerability.

## [0.4.0] - 2026-06-03

### Added
- `wildcard` command (agent complaint box; also aliased as `complaint-box` and `report-blocker`): records a free-form "this capability is unavailable" complaint as feedback tagged `creator_type: agent`. Always prints a terminal de-loop message and exits `0` so the agent stops retrying; if the feedback could not be recorded (not logged in, server error) the message says so and a warning is logged so the failure still surfaces. Requires `--complaint` and `--agent-name` (or the `COOLHAND_AGENT_NAME` environment variable); accepts optional `--thinking` and `--log-id`.
- `capture-sessions` command: scans local Claude Code session transcripts and submits them to the Coolhand API as feedback. Tracks already-submitted sessions per client via `~/.coolhand/capture-state.json` to avoid duplicates. Supports `--dry-run` (report counts without sending) and `--json` output. Requires a configured Coolhand client.
- `coolhand-node` is now a runtime dependency, used by `wildcard` to submit feedback.

## [0.3.0] - 2026-05-27

### Added
- `--page` and `--per-page` pagination flags on `search-optimizations`; text output now includes a `Page N of M (X total)` hint.
- `--template-id`, `--workload-id`, `--days-back` filter flags on `search-optimizations`.
- `--sort-by` flag on `search-optimizations` (`impact_desc` | `complexity_asc` | `created_at_desc`).
- `get-optimization` now surfaces `pr_number` and `pr_url` (printed as `PR: #N <url>` when present).
- `get-optimization` renders `coding_prompt` in a separate `--- Coding Prompt ---` block with preserved newlines.

### Fixed
- `get-optimization` was sending `id` instead of `optimization_id` to the MCP server, causing "Invalid params" errors for all calls.

### Changed
- `src/version.ts` is now gitignored and auto-generated from `package.json` at build time; version bumps only require editing `package.json`.
- Test coverage thresholds raised to 70/65/60/70.

## [0.2.0] - 2026-05-25

### Added
- Six optimization commands: `create-optimization`, `get-optimization`, `update-optimization`, `close-optimization`, `add-optimization-comment`, `search-optimizations`.
- `mcp-call` command for direct MCP tool invocation.
- `--scope private` flag on `login` to authenticate against private workspaces.
- Per-command `--help` output for all commands.

### Changed
- npm version badge added to README.

## [0.1.0] - 2026-05-12

### Added
- Initial release.
- `coolhand login` — browser-based OAuth-style flow that delivers a public Coolhand API token to the terminal via a localhost callback (same pattern as `gh auth login` and `gcloud auth login`).
- `coolhand logout` — remove one or all stored clients.
- `coolhand status` — programmatic check (`--json`) and exit code reporting whether a token is configured.
- `coolhand whoami` — human-readable rendering of `status`.
- `coolhand clients` — list configured clients and switch the default with `coolhand clients use <id>`.
- Multi-client support from day one. Tokens are stored in `~/.coolhand/config.json` (mode `0o600`) keyed by `client_id`, with a `default_client_id` pointer.
- Optional `--write-env PATH` flag on `login` to idempotently append/replace `COOLHAND_API_KEY` in a project `.env` file.
- Two bin aliases: `coolhand` (after global install) and `coolhand-cli` (for `npx coolhand-cli` one-shot use).

### Security
- HTTP callback listener binds to `127.0.0.1` only.
- Single-shot server: rejects any subsequent callbacks after the first valid one.
- CSRF protection via 16-byte random `state` parameter, verified with `crypto.timingSafeEqual`.
- Raw API tokens are never written to stdout or stderr. JSON outputs use a masked form (e.g. `e885b463…1148`).
- Config files written atomically (tmp + rename + chmod) with mode `0o600`; parent directory `0o700`.
- Zero runtime dependencies — minimal supply-chain surface for the auth flow.

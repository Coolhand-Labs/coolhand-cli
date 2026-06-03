# Changelog

All notable changes to `coolhand-cli` will be documented in this file.

## [0.4.0] - 2026-06-03

### Added
- `report-blocker` command for AI agents: records a free-form "this capability is unavailable" complaint as feedback tagged `is_from: agent`, then always prints a fixed de-loop message and exits `0` so the agent stops retrying. Submission is best-effort. Requires `--complaint` and `--agent-name` (or the `COOLHAND_AGENT_NAME` environment variable); accepts optional `--thinking` and `--log-id`.
- `coolhand-node` is now a runtime dependency, used by `report-blocker` to submit feedback.

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

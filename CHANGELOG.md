# Changelog

All notable changes to `coolhand-cli` will be documented in this file.

## [Unreleased]

### Added
- `upload-client-file` command: uploads a local file to Coolhand as a client file (via
  coolhand-node's new `Coolhand#uploadClientFile`), with `--name`, `--file-type`,
  `--description`, `--dry-run`, `--client-id`, and `--json`. Requires a private API key
  (`coolhand login --scope private`) — the public key used for LLM capture 401s on
  `client_files`. A conservative 20MB size cap matches coolhand-node's own documented
  `uploadClientFile` guidance. See [docs/commands.md](./docs/commands.md#upload-client-file).
- `map-claude-projects` command: recursively searches the home directory (or `--root`) for every
  folder named `claude`/`Claude`, or `.claude`/`.Claude` (case-insensitive exact match, not a
  substring match), and uploads a single markdown
  report — via the same shared upload core as `upload-client-file` (private key, same as above)
  — listing the full file tree beneath each match with basic metadata (size, extension,
  created/modified times). Uploads **names and metadata only, never file contents**. No
  exclusions are applied to the search or the listing. Supports `--root`, `--output` (write the
  generated report to a local path for inspection, independent of uploading), `--dry-run`,
  `--client-id`, and `--json`. See [docs/commands.md](./docs/commands.md#map-claude-projects).
- `analyze-claude-sessions` now attaches `metadata.project_path` to submitted Claude Code
  sessions (via coolhand-node's new `logRequest` `metadata` option), taken from the transcript's
  own `cwd`. Cowork sessions never get a guessed `project_path`, since Cowork has no real
  on-disk project concept.

### Changed
- `coolhand-node` bumped to `^0.11.0` (published to npm), which includes the `logRequest`
  `metadata` option and `uploadClientFile` this CLI depends on. Previously pinned to a specific
  commit on an unmerged branch while that PR
  ([coolhand-node#159](https://github.com/Coolhand-Labs/coolhand-node/pull/159)) was in review;
  now that it's shipped, this drops the git dependency. Note the backend may not yet have deployed
  `metadata`/`client_files` support, so live uploads and `project_path` may 404 or be silently
  ignored until it does.

### Security
- Client names and feedback explanations printed to the terminal (`status`, `whoami`, `clients`, `get-feedback`, etc.) are now stripped of ANSI/VT100 escape sequences before printing, closing a terminal-control-sequence injection vector via server-controlled text — e.g. a `client_name` set via the OAuth callback, or a feedback `explanation` writable via `coolhand wildcard` using only a public key (#95).
- The Coolhand MITM proxy (`coolhand claude`/`coolhand monitor`) now also excludes coolhand-node's `DEFAULT_EXCLUDE_API_PATTERNS` (e.g. batch-prediction-job status polling) from capture, matching upstream SDK behavior (#95).

### Fixed
- `redactSecrets` (the scrubber `analyze-claude-sessions` applies to transcript content before
  it's submitted) now catches secrets in plain JSON —
  `{"api_key": "value"}` — not just unquoted-key assignment syntax (`api_key: value`,
  `api_key=value`). The assignment regex previously required the keyword to be followed
  immediately by `:`/`=`, but a JSON key is followed by its own closing quote first, so an opaque
  secret stored as a normal JSON string value (the single most common real-world shape, and the
  dominant format under `~/.claude`) sailed through unredacted unless it also happened to match one
  of the hardcoded token-shape patterns (`ghp_`, `sk-`, `AKIA`, etc.). Also added a pattern for
  PEM-formatted private key blocks (SSH/RSA/EC/OpenSSH/PGP), which had no coverage at all before —
  no assignment keyword sits next to the base64 body, so the assignment regexes alone never caught
  a `cat ~/.ssh/id_rsa`-style output or an embedded deploy key.
- Pinned the transitive `ip-address` dependency (pulled in by `mockttp` via `socks-proxy-agent`/`socks`) to `^10.4.0` via `overrides`, resolving a high-severity SSRF/trust-boundary-bypass advisory (`ip-address` `<=10.3.0`) flagged by `npm audit --omit=dev --audit-level=high` in CI.
- Pinned the transitive `get-port` dependency (pulled in by `mockttp`) to `^5.1.1` via `overrides`. `mockttp`'s CommonJS build does a top-level `require("get-port")`, but `get-port@6+` is ESM-only, so every invocation — including `coolhand-cli --help` — crashed with `ERR_REQUIRE_ESM` on Node 22 before any command parsing happened (#108).
- `coolhand login --base-url` and the `monitor`/`claude` proxy path (`endpointForBaseUrl`) now enforce the same https-except-loopback rule that `fetch-log`/`search-logs`/`search-feedback`/`get-feedback`/`mcp-call` already got for free from the `coolhand-node` SDK. Previously `login --base-url http://some-non-loopback-host` was accepted and silently stored, and the proxy path performed no scheme validation at all — so `monitor`/`claude` would ship captured prompts, completions, and the public API key over cleartext HTTP to a non-loopback host while every other command correctly refused it (#94).
- `analyze-claude-sessions --exclude-project` now applies to Cowork sessions. Previously it was silently a no-op for them since Cowork sessions have no project folder to compare against; the filter now fails closed and excludes them, mirroring how `--project` already treats them (#95).
- Windows: `resolveWrapSpawn` (used by `coolhand claude`/`coolhand monitor`) now escapes the spawned command token the same way it already escaped each argument, closing a quoting inconsistency that could let an embedded `"` in the command break out of the quoted `cmd.exe` invocation (#95).

## [0.9.0] - 2026-08-01

### Added
- `fetch-log` and `search-logs` commands: fetch a single LLM request log's input/output content, or search logs with flexible filters, via `GET /api/v2/llm_request_logs/{id}` / `GET /api/v2/llm_request_logs` (coolhand-node's `Coolhand#getLogContent`/`searchLogs`). Requires a private API key (`coolhand login --scope private`). `fetch-log <log-id>` supports `--section`, `--max-chars`, `--search-query`, and `--include-thinking`; `search-logs` supports `--template-id`, `--workload-id`, `--system-prompt-contains`, `--user-prompt-contains`, `--model`, `--source-api`, `--source-api-result`, `--unmatched-only`, `--days-back`, `--include-prompts`, `--sort`, and pagination. `search-logs`' response is `{ logs, pagination }`, matching `search-feedback`'s shape (pagination totals are a conservative lower-bound estimate until the backend exposes exact totals; see [Coolhand-Labs/coolhand-cli#90](https://github.com/Coolhand-Labs/coolhand-cli/issues/90)). See [docs/commands.md](./docs/commands.md#log-access). (#70, coolhand-node#108)

## [0.8.0] - 2026-07-30

### Added
- `search-feedback` and `get-feedback` commands: search/list and fetch feedback records (`GET /api/v2/llm_request_log_feedbacks`, via coolhand-node's new `Coolhand#searchFeedback`/`getFeedback`). Requires a private API key (`coolhand login --scope private`) — the public key used by `wildcard`/`createFeedback` 401s on these read endpoints. `search-feedback` supports `--sentiment`, `--search`, `--creator-id`, `--workload-id`, `--matched`/`--unmatched`, `--since`, `--sort-by`/`--sort-dir`, and pagination; `get-feedback <id>` prints a human-readable summary including `original_output`/`revised_output`/`feedback_partials`, which list results omit. See [docs/commands.md](./docs/commands.md#feedback). (#71)
- `analyze-claude-sessions` gains upload filters: `--since`/`--until` (date, ISO datetime, or `12h`/`7d`/`2w` duration) narrow by modified time, `--project`/`--exclude-project` narrow by project folder name, and `--projects-dir` redirects the scan to a custom directory (and skips Cowork sessions, which have no equivalent override). Filtered sessions are never read from disk, and a filtered run never advances the incremental sync cutoff — see [docs/session-capture.md](./docs/session-capture.md#choosing-what-gets-uploaded).
- `get-optimization` now prints a human-readable summary by default (title, status, type, category, impact, complexity, client/template/workload, created date, analysis, and plan) instead of a raw JSON dump, plus a "Next steps" footer pointing to `close-optimization`/`update-optimization`.
- `get-optimization --full` flag: includes the internal `orchestrator_messages` transcript (and any `thoughtSignature` blobs it contains) on both text and `--json` output. This is omitted by default — including from `--json` output, which previously always returned the complete raw payload — since it can add tens of KB of internal agent-transcript data that isn't decision-relevant for most callers. Pass `--full --json` to get the complete payload as before.

### Fixed
- `login` no longer silently drops a previously-stored `private_key` when a later plain `coolhand login` (public scope only) re-authenticates the same client. `upsertClient` now merges onto the existing stored entry instead of fully replacing it, fixing intermittent 401s on private-scope commands (`update-workload`, `list-workloads`) after re-logging in without `--scope private` (#59).
- `close-optimization` now sends `explanation` (matching what the backend `close_optimization` tool actually requires) instead of `reason` in the underlying API call. The CLI-facing `<reason>` positional argument is unchanged; only the outgoing field name was corrected. Previously this command failed against the real API.
- `get-optimization` now correctly unwraps the `{ optimization: {...} }` response shape returned by the backend. Previously fields (`pr_number`, `pr_url`, `coding_prompt`, etc.) were read from the top level and were silently never populated.

### Changed
- `mcp-call` 401 errors now include a hint to run `coolhand login --scope private` to re-authenticate.
- `status`, `whoami`, and `clients` now also display whether a private key is stored (masked, or `(no private key)`), via a new `masked_private_key` field in JSON output and an extra column in `clients`' plain-text listing.

## [0.7.0] - 2026-07-03

### Added
- `monitor` command: generalizes the in-process MITM proxy wrapping that `claude` already provides to any CLI (e.g. `coolhand monitor -- kimi --resume`), so other tools' outbound LLM traffic can be captured the same way, without a separate daemon process.

## [0.6.0] - 2026-07-02

### Added
- `list-workloads` command: browse and search workloads by name with pagination (`--search`, `--page`, `--per-page`, `--include-archived`, `--include-system`, `--include-templates`). Requires a private API key (`coolhand login --scope private`).
- `get-workload --id <id>` and `update-workload --id <id> [--name VALUE] [--description VALUE]` commands: fetch or rename/re-describe a single workload. Unlike `get-optimization`/`update-optimization`, the ID is passed via `--id` rather than as a positional argument, since `--workload-id` is already an established flag name elsewhere in the CLI for *filtering by* workload — using `--id` here avoids reusing that name for a different meaning. `update-workload` requires at least one of `--name`/`--description`; renaming a system workload (`Unmatched`, `Embedding Requests`, `Ignored API Calls`) is rejected by the API, though updating its description is allowed.
- `--client-id ID` now works as a **global flag** placed before the subcommand (e.g. `coolhand --client-id acme list-workloads`) in addition to the existing per-command position. This also applies to `coolhand claude`.
- `COOLHAND_CLIENT_ID` environment variable: set it to a stored client ID to select that client without passing `--client-id` on every invocation. Priority: `--client-id` flag > `COOLHAND_CLIENT_ID` env > configured default > auto-pick (single client) > interactive prompt.
- When multiple clients are stored and no default is configured, API commands now **prompt interactively** (TTY) or emit a descriptive error listing all clients (non-TTY) instead of failing with NOT_CONFIGURED.
- `claude`, `wildcard`, `mcp-call`, `analyze-claude-sessions`, `list-workloads`, `search-optimizations`, `get-optimization`, `close-optimization`, `update-optimization`, `get-workload`, and `update-workload` now print `Client: <name> (<id>)` to stderr when a stored client is used, so the active account is always visible.
- `wildcard` now saves feedback locally to `~/.coolhand/pending/` when no API key is configured, instead of silently dropping it. Pending feedback is automatically uploaded on the next `coolhand login`. A background flush retry runs after each login; if it fails, a reminder prompt appears on the next interactive command.

### Changed
- `coolhand claude` now starts an in-process HTTPS MITM proxy (powered by `mockttp`) instead of shelling out to the `coolhand-proxy` binary; the `coolhand-proxy` dependency has been removed. A CA certificate is generated on first run and persisted to `~/.coolhand/proxy/ca-cert.pem`; see `docs/proxy.md` for system trust store installation instructions.
- `coolhand claude` now works correctly on Windows: the `claude` binary (a `.cmd` shim) is spawned via `cmd.exe /d /s /c` with explicit argument quoting, preventing metacharacter injection without requiring `shell: true`.
- `mcp-call` now uses the shared client-resolution chain (`resolveClient`) instead of calling `getClient` directly, gaining `COOLHAND_CLIENT_ID` support, interactive client selection on TTY, and the `Client:` label on stderr.
- `analyze-claude-sessions` now surfaces resolution errors when clients are stored but none can be auto-selected (e.g. multiple clients, no default, non-TTY). Previously this was silently treated as "unauthenticated", which produced a confusing no-op. Dry-run without any stored clients still works unauthenticated.
- `analyze-claude-sessions` now aborts the entire run (rather than counting it as a per-session failure) when `logRequest` throws `INVALID_ARGS`. A malformed session envelope would fail identically on every retry, so aborting fast avoids burning through all remaining sessions.
- When `default_client_id` points to a client that no longer exists, a warning is emitted before falling through to auto-pick or the interactive prompt (previously this fell through silently).
- `coolhand login --scope private` no longer errors (`INVALID_CALLBACK`) when the user declines the private key on the consent page. It now succeeds, stores only the public key, and prints a note that MCP access was not granted.
- Login can now succeed with only a private (MCP) key — `api_key` is omitted from the stored config entry when the public key was not granted.
- `coolhand claude` now exits with a clear error if the configured client has no public API key, rather than spawning the proxy silently without a logging key.
- `coolhand claude` (and all other API commands) now prompt interactively when multiple clients are stored and no default is set. In non-TTY environments (CI, scripts) this produces a descriptive error listing available clients instead of a generic NOT_CONFIGURED. Use `--client-id` or `COOLHAND_CLIENT_ID` to select a client non-interactively.
- `status`, `whoami`, and `clients` display `(no public key)` instead of `***` for clients that have only a private key.
- `mcp-call` now treats a tool result shaped `{ error: "..." }` (the convention every backend MCP tool uses for business-logic failures, e.g. "Cannot rename system workloads") as a failure. Previously only a top-level JSON-RPC `error` field was checked, so a rejected tool call (bad workload ID, disallowed rename, etc.) exited 0 and printed the raw `{"error": "..."}` object as if it were a successful result.

### Docs
- README `analyze-claude-sessions` section clarifies exactly what gets uploaded (conversation transcripts from `~/.claude/projects/`) and replaces "scans" with "analyzes"/"capture" for accuracy.

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

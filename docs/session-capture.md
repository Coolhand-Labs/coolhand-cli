# Session Capture

`coolhand analyze-claude-sessions` imports locally-saved **Claude Code** sessions into Coolhand so the
platform can analyse work that never went through an instrumented SDK. Each Claude Code session is
captured as **one conversation log** (not one log per message).

## Sources

The command scans two local session stores and merges the results:

| Source | Path | URL scheme |
| ------ | ---- | ---------- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `claudecode://session/<id>` |
| Claude Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions/**/local_*/audit.jsonl` | `cowork://session/<uuid>` |

The Cowork path is macOS-specific; on other platforms it simply yields zero sessions. Both sources
use the same deduplication state, so a session submitted from one source is never re-submitted as
the other.

## What it does

1. **Scan.** Reads every session transcript from both sources above. A missing directory simply
   yields zero sessions. The tool is general — each user runs it on their own machine and submits
   to their own Coolhand account.
2. **Assemble.** Turns each transcript into **one** envelope holding the whole conversation in
   `request_body.messages`: every user and assistant message, in order, with **tool calls and tool
   results serialised inline** so the actual work — not just the chat — is preserved. Assistant
   *thinking* is omitted for now, likely secrets (API keys, tokens, `KEY=value` pairs) are redacted,
   and oversized tool inputs/outputs are truncated. A single assistant turn split across multiple
   transcript lines is merged into one message, and its token usage (including
   `cache_creation_input_tokens`) is summed **once**. The final assistant turn goes in
   `response_body`; the session's summed usage in `response_body.usage`.
3. **Submit.** POSTs one envelope per session to `POST /api/v2/llm_request_logs`, with the collector
   string `coolhand-cli/claude-code`.

Each envelope is Anthropic-shaped and wrapped in a session-level url:

```
claudecode://session/<sessionId>
```

The server's `claude_code` ingestor recognises this url, stores the multi-message conversation as one
`chat` log (the Anthropic ingestor already handles a full conversation), and uses the **sessionId**
as the per-session unique id.

## How duplicates are avoided

The tool keeps a small local **state file** (`capture-state.json`, in the same config folder as
`config.json`) listing the session ids it has already submitted, **scoped per client**. Before
sending a session it checks this list and **skips** anything already sent, so re-running
`analyze-claude-sessions` does not create duplicate logs.

This is done in the tool because the server cannot reliably deduplicate these logs itself: its
duplicate check runs before a log is classified, and once a log is matched to a template it is never
re-checked.

## Scope: initial import and incremental updates

`analyze-claude-sessions` handles both the initial import and incremental updates in one command:

- **New sessions** — submitted on first run, recorded in local state.
- **Updated sessions** — if a session has more turns than when it was last submitted, the full
  updated conversation is re-uploaded. Turn count (not file mtime) is the source of truth for
  whether a re-upload is needed; mtime is only used as a cheap pre-filter to skip files that
  clearly haven't changed.
- **Unchanged sessions** — skipped entirely.

The command is safe to re-run at any time. Ongoing, real-time capture (each turn as it happens)
is handled by the Coolhand proxy (`coolhand claude`), which submits turns live with their session id.

## Choosing what gets uploaded

By default every session found under the two sources is a candidate. Teams with private
projects or compliance constraints can narrow a run to a time window, a scan location, or a
set of projects:

```bash
# Only sessions touched in the last week
coolhand analyze-claude-sessions --since 7d

# A fixed window (dates are whole local days: June, inclusive)
coolhand analyze-claude-sessions --since 2026-06-01 --until 2026-06-30

# Only sessions from one project's folder; or everything except it
coolhand analyze-claude-sessions --project coolhand-cli
coolhand analyze-claude-sessions --exclude-project clients-secret-repo

# Scan a different directory entirely
coolhand analyze-claude-sessions --projects-dir D:/exports/claude-projects
```

`--project`/`--exclude-project` repeat (`--project a --project b`) or take comma lists
(`--project a,b`) and match project folder names as case-insensitive substrings. Cowork
sessions have no project folder, so both directions fail closed for them: an include filter
(`--project`) excludes all Cowork sessions (they can't match anything to include), and
`--exclude-project` also skips all Cowork sessions (there's no project identity to compare
against, so they're treated as excluded rather than silently passed through).
Combine any of these with `--dry-run` first to preview the effect; the summary reports how
many sessions `--until`, `--project`, and `--exclude-project` excluded (the "filtered out"
count). `--since` uses the same mtime cutoff as the routine incremental scan, so its
exclusions aren't broken out separately — they'd be indistinguishable from the sessions a
normal run already skips for being unchanged since the last sync.

`--until`, `--project`, and `--exclude-project` narrow *within* the normal incremental window
— they don't lower it. On a machine that has already synced, sessions older than the last
successful sync are excluded by that cutoff regardless of these flags. Pair with `--since` to
reach further back (e.g. `--since 2026-01-01 --until 2026-01-31` for a full window into the
past).

### Privacy & compliance guarantees

- **Filtered sessions are never read.** Time, project, and location filters run on file
  metadata (name, folder, modified time) before the transcript is opened — excluded content
  never leaves disk, let alone the machine.
- **Filtered runs never advance the sync cutoff.** A normal run records `lastSyncAt` so the
  next run can skip unchanged files. When any filter narrowed the run, that cutoff is left
  untouched — otherwise sessions excluded this run would be silently skipped by every future
  run. The summary says so explicitly: `(sync cutoff not advanced — filters active)`.

## Flags

| Flag                | Effect                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `--dry-run`         | Scan and report what would be submitted, without sending anything. |
| `--client-id`       | Use a specific stored client instead of the default.               |
| `--json`            | Emit machine-readable JSON output instead of human-readable text.  |
| `--since WHEN`      | Only sessions modified at or after WHEN (`YYYY-MM-DD`, ISO datetime, or `12h`/`7d`/`2w`). |
| `--until WHEN`      | Only sessions modified at or before WHEN (a plain date means its whole day). |
| `--projects-dir`    | Scan a custom directory instead of `~/.claude/projects`; also skips Cowork sessions entirely, since they have no equivalent override. |
| `--project`         | Only matching project folders (repeatable, comma-separable).       |
| `--exclude-project` | Skip matching project folders (repeatable, comma-separable).       |

The canonical flag reference lives in [commands.md](./commands.md#analyze-claude-sessions).

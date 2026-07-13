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

## Flags

| Flag           | Effect                                                              |
| -------------- | ------------------------------------------------------------------ |
| `--dry-run`    | Scan and report what would be submitted, without sending anything. |
| `--client-id`  | Use a specific stored client instead of the default.               |
| `--json`       | Emit machine-readable JSON output instead of human-readable text.  |

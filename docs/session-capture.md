# Session Capture

`coolhand capture-sessions` imports locally-saved **Claude Code** sessions into Coolhand so the
platform can analyse work that never went through an instrumented SDK. Each Claude Code session is
captured as **one conversation log** (not one log per message).

## What it does

1. **Scan.** Reads every `*.jsonl` transcript under `~/.claude/projects/` (recursively). A missing
   directory simply yields zero sessions. The tool is general — each user runs it on their own
   machine and submits to their own Coolhand account.
2. **Assemble.** Turns each transcript into **one** envelope holding the whole conversation: every
   user and assistant message, in order, in `request_body.messages`; the final assistant turn in
   `response_body`; and the session's **summed** token usage in `response_body.usage`.
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
`capture-sessions` does not create duplicate logs.

This is done in the tool because the server cannot reliably deduplicate these logs itself: its
duplicate check runs before a log is classified, and once a log is matched to a template it is never
re-checked.

## Scope: one-time historical import

`capture-sessions` is a **one-time historical import**, and safe to re-run (already-submitted
sessions are skipped). It does **not** incrementally pick up new turns added to a session after it was
first submitted — a re-scan skips that session entirely. Ongoing, real-time capture is intended to
move to the Coolhand proxy, which submits each turn live with its session id.

## Flags

| Flag           | Effect                                                              |
| -------------- | ------------------------------------------------------------------ |
| `--dry-run`    | Scan and report what would be submitted, without sending anything. |
| `--client-id`  | Use a specific stored client instead of the default.               |
| `--json`       | Emit machine-readable JSON output instead of human-readable text.  |

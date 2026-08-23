# Command Reference

Full flag reference and usage notes for all coolhand-cli commands.

## Global Flags and Client Selection

All commands that make API calls accept `--client-id ID` to choose which stored account to use. The flag can appear **before or after** the subcommand name (except `claude`, where it must come before — see the [`claude`](#claude) section below):

```bash
coolhand --client-id acme list-workloads   # global position
coolhand list-workloads --client-id acme   # per-command position
coolhand --client-id acme claude ...       # must be before for claude
```

`COOLHAND_CLIENT_ID=acme coolhand list-workloads` is the environment-variable equivalent and is useful in scripts or CI where passing flags is inconvenient.

**Client selection priority** (highest to lowest):

1. `--client-id ID` flag
2. `COOLHAND_CLIENT_ID` env var
3. Configured default (`coolhand clients use <id>`)
4. Auto-pick when exactly one client is stored
5. Interactive prompt (TTY) or descriptive error listing all clients (non-TTY)

Any command that calls `resolveClient` prints `Client: <name> (<id>)` to stderr when a client is successfully resolved, so you always know which account's data you are looking at. `wildcard`, `analyze-claude-sessions`, `map-claude-projects`, and `upload-client-file` print the label when a client is resolved but proceed without one when **no clients are configured at all** (`wildcard` is designed for logged-out sandbox agents; the other three allow `--dry-run` without credentials, via the shared `resolveClientForDryRun` helper). These commands differ when clients are stored but resolution fails (e.g. no default is set on a non-TTY): `wildcard` saves the complaint locally and warns rather than blocking the agent; the rest surface the error so the misconfiguration is visible.

## Authentication

### login

```bash
coolhand login [--base-url URL] [--scope private] [--write-env PATH] [--client-id ID] [--timeout-ms MS] [--json]
```

Opens your browser to the Coolhand consent page, listens on `127.0.0.1` for the callback, and stores the granted key(s). The **public** `api_key` is used for LLM capture with `coolhand-node`, `coolhand-python`, and the `coolhand-js` widget.

`--scope private` requests the **private (MCP) key** in addition to the public key. The user may grant either or both on the consent page; the CLI stores whichever keys are granted and notes if any were withheld.

`--write-env PATH` writes granted keys to the target `.env` file: `COOLHAND_API_KEY=<token>` and/or `COOLHAND_PRIVATE_KEY=<private_token>` (idempotent — replaces existing values rather than appending duplicates).

`--timeout-ms MS` overrides how long the CLI waits for the browser callback before giving up (default: 300000, i.e. 5 minutes — see [auth-flow.md](./auth-flow.md)).

`--base-url URL` points the CLI at a non-default Coolhand instance and is stored as the client's `base_url` for all later requests. It must use `https://`; `http://` is only accepted for `localhost`/`127.0.0.1`/`::1`, matching the restriction `coolhand-node` enforces on every other API call — a non-loopback `http://` URL is rejected outright rather than silently stored.

See [auth-flow.md](./auth-flow.md) for the full callback sequence, state machine, and error paths.

### logout

```bash
coolhand logout [--client-id ID | --all] [--json]
```

Removes a stored client. `--all` clears every stored client.

### status

```bash
coolhand status [--client-id ID] [--json]
```

Exit code `0` if a token is configured for the default (or requested) client, `1` otherwise.

`--json` emits a machine-readable response useful for integrations:

```json
{
  "configured": true,
  "clients": [
    {"client_id": "acme", "client_name": "Acme Inc",
     "masked_token": "e885b463…1148", "masked_private_key": "ch_priv_a…b6a4",
     "base_url": "https://coolhandlabs.com"}
  ],
  "default_client_id": "acme"
}
```

`masked_token` is `"(no public key)"` when only a private key was granted. Likewise `masked_private_key` is `"(no private key)"` when no private key is stored — run `coolhand login --scope private` to obtain one.

### whoami

```bash
coolhand whoami [--client-id ID]
```

Prints the currently configured client name, ID, masked public token, masked private key (or `(no private key)`), and base URL.

### clients

```bash
coolhand clients [use <id>] [--json]
```

Lists all stored clients. `coolhand clients use <id>` switches the default. Each `coolhand login` adds (or refreshes) one entry, keyed by the server-assigned `client_id`.

The plain-text listing is `<id>  <name>  <masked public key>  <masked private key>  <base_url>` (one client per line, default marked with `*`). The masked private key column is `(no private key)` when none is stored. Scripts parsing this output by column position should account for this column.

## LLM Capture

### claude

```bash
coolhand [--client-id ID] claude [claude args...]
```

Runs the Claude CLI through an in-process HTTPS MITM proxy (powered by `mockttp`), capturing outbound LLM API calls and forwarding them to Coolhand. Any arguments after `claude` are passed straight to the Claude CLI:

```bash
coolhand claude                          # starts Claude with capture on
coolhand claude --resume                 # resume last session, captured
coolhand --client-id acme claude         # capture under the "acme" account
```

On first run a self-signed CA certificate is generated at `~/.coolhand/proxy/ca-cert.pem`; the Claude process trusts it automatically via `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `REQUESTS_CA_BUNDLE`. For other tools or system-wide trust, see [docs/proxy.md](./proxy.md).

| Flag | Description |
|------|-------------|
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var). Must come **before** `claude` — anything after `claude` is forwarded to the Claude CLI verbatim, so `coolhand claude --client-id acme` passes `--client-id acme` to Claude itself (which does not recognize it). |

### monitor

```bash
coolhand [--client-id ID] monitor [--] <command> [args...]
```

Runs an arbitrary CLI through the same in-process HTTPS MITM proxy `claude` uses, capturing outbound LLM API calls and forwarding them to Coolhand. Generalizes `claude`'s proxy wiring to any tool (e.g. `kimi`). A leading `--` is optional and, if present, is stripped before the wrapped command name:

```bash
coolhand monitor -- kimi                    # starts kimi with capture on
coolhand monitor kimi --resume              # the -- is optional
coolhand --client-id acme monitor -- kimi   # capture under the "acme" account
```

On first run a self-signed CA certificate is generated at `~/.coolhand/proxy/ca-cert.pem`; the wrapped process trusts it automatically via `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `REQUESTS_CA_BUNDLE`. See [docs/proxy.md](./proxy.md) for details.

| Flag | Description |
|------|-------------|
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var). Must come **before** `monitor` — anything after it is forwarded to the wrapped command verbatim. |
| `<command> [args...]` | The CLI to run and its arguments, e.g. `kimi --resume`. |

## Workloads

### list-workloads

```bash
coolhand list-workloads [--search TEXT] [--page N] [--per-page N]
                        [--include-archived] [--include-system]
                        [--include-templates] [--client-id ID] [--json]
```

Lists workloads with optional filtering and pagination.

| Flag | Description |
|------|-------------|
| `--search TEXT` | Filter by name substring (case-insensitive) |
| `--page N` | Page number (default: 1) |
| `--per-page N` | Results per page (default: 25, max: 100) |
| `--include-archived` | Include archived workloads |
| `--include-system` | Include system workloads (e.g. Unmatched) |
| `--include-templates` | Expand each workload with its templates and routing regex patterns |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

When `--include-templates` is set, each workload entry includes a `templates` array:

```json
{
  "id": "k8z184s5lox7",
  "name": "Optimization Agent",
  "templates": [
    {
      "id": "mv26m7cge4yj",
      "name": "Optimization Agent (gemini-2.5-pro)",
      "status": "published",
      "user_prompt_pattern": ".*",
      "system_prompt_pattern": "You are an expert..."
    }
  ]
}
```

The `templates` key is absent entirely when `--include-templates` is not passed. Templates are active-only (deprecated and `failure`-status templates are excluded).

Human-readable output includes a pagination hint: `Page N of M (X total) — use --page N to navigate`.

### get-workload

```bash
coolhand get-workload --id <id> [--client-id ID] [--json]
```

Fetches a single workload by ID.

| Flag | Description |
|------|-------------|
| `--id ID` | Workload ID (required) |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

### update-workload

```bash
coolhand update-workload --id <id> [--name VALUE] [--description VALUE]
                          [--client-id ID] [--json]
```

Updates a workload's name and/or description. At least one of `--name` or `--description` is required. If a value starts with a dash (e.g. `-1 fix`), use `--name=VALUE`/`--description=VALUE` instead of the space-separated form, or it will be misread as a flag.

| Flag | Description |
|------|-------------|
| `--id ID` | Workload ID (required) |
| `--name VALUE` | New name (system workloads such as Unmatched, Embedding Requests, and Ignored API Calls cannot be renamed) |
| `--description VALUE` | New description |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

## Optimizations

Coolhand stores LLM-generated optimization suggestions as structured records. These commands let you query, update, and act on them from the terminal or from agent workflows.

### search-optimizations

```bash
coolhand search-optimizations [--status V] [--type V] [--category V] [--query V]
                               [--from DATE] [--to DATE] [--days-back N]
                               [--template-id ID] [--workload-id ID]
                               [--sort-by impact_desc|complexity_asc|created_at_desc]
                               [--page N] [--per-page N] [--client-id ID] [--json]
```

| Flag | Description |
|------|-------------|
| `--status V` | Filter by status (e.g. `open`, `closed`) |
| `--type V` | Filter by optimization type |
| `--category V` | Filter by category |
| `--query V` | Free-text search |
| `--from DATE` | Start of date range |
| `--to DATE` | End of date range |
| `--days-back N` | Only show optimizations from the last N days |
| `--template-id ID` | Filter to a specific template |
| `--workload-id ID` | Filter to a specific workload |
| `--sort-by V` | Sort order: `impact_desc`, `complexity_asc`, or `created_at_desc` |
| `--page N` | Page number (default: 1) |
| `--per-page N` | Results per page (default: 20, max: 50) |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

### get-optimization

```bash
coolhand get-optimization <id> [--full] [--client-id ID] [--json]
```

Fetches a single optimization by ID. Default output is a human-readable summary (ID, title,
status, type, category, impact, complexity, client, template, workload, created date, dismissal
reason, analysis, and plan, when present), followed by PR information (`PR: #N <url>`) and a
`--- Coding Prompt ---` block when present, and a "Next steps" footer pointing to
`close-optimization`/`update-optimization`.

The backend response also includes an internal `orchestrator_messages` field — the full
tool-call transcript from the agent that produced the optimization, including raw model
`thoughtSignature` blobs. This is large (tens of KB) and not decision-relevant for most
callers, so it is **omitted by default** from both text and `--json` output. Pass `--full` to
include it in either mode.

| Flag | Description |
|------|-------------|
| `--full` | Include the internal `orchestrator_messages` transcript (large; contains raw `thoughtSignature` blobs), on both text and `--json` output |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

### update-optimization

```bash
coolhand update-optimization <id> [--title V] [--analysis V] [--plan V] [--client-id ID] [--json]
```

Updates an existing optimization. Only the flags you provide are changed.

| Flag | Description |
|------|-------------|
| `--title V` | New title |
| `--analysis V` | New analysis text |
| `--plan V` | New plan text |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

### close-optimization

```bash
coolhand close-optimization <id> <reason> [--client-id ID] [--json]
```

Closes an optimization. The reason is a free-text positional argument (quote it if it contains spaces).

| Flag | Description |
|------|-------------|
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

## Feedback

Search and inspect feedback records (the same records `wildcard` and the Coolhand SDKs create). Both commands require a **private** API key (`coolhand login --scope private`) — the public key is write-only for this resource and gets a 401.

### search-feedback

```bash
coolhand search-feedback [--sentiment positive|negative|neutral] [--search TEXT]
                          [--creator-id ID] [--workload-id ID]
                          [--matched] [--unmatched] [--since DATE]
                          [--sort-by created_at|updated_at] [--sort-dir asc|desc]
                          [--page N] [--per-page N] [--client-id ID] [--json]
```

Lists feedback records with optional filtering, sorting, and pagination. List items omit `original_output`/`revised_output` (each can hold up to 1GB) — use `get-feedback` to fetch those for a specific record.

| Flag | Description |
|------|-------------|
| `--sentiment positive\|negative\|neutral` | Filter by sentiment |
| `--search TEXT` | Filter by explanation substring |
| `--creator-id ID` | Filter by `creator_unique_id` |
| `--workload-id ID` | Filter by workload ID |
| `--matched` | Only feedback linked to an LLM request log |
| `--unmatched` | Only feedback not linked to an LLM request log |
| `--since DATE` | Only feedback created at or after DATE |
| `--sort-by created_at\|updated_at` | Sort field (default: `created_at`) |
| `--sort-dir asc\|desc` | Sort direction (default: `desc`) |
| `--page N` | Page number (default: 1) |
| `--per-page N` | Results per page (default: 25, max: 100) |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

Human-readable output includes a pagination hint: `Page N of M (X total) — use --page N to navigate`.

`--matched`/`--unmatched` and the other flags above are the full set the backend currently supports filtering on. Filtering by whether a record has a revision (`revised_output`), or whether it's linked to an optimization, isn't offered here because the API doesn't expose those as filterable — `revised_output` is excluded from the server's search-whitelist entirely (unbounded text, same reason list items omit it), and optimization-linkage isn't a searchable field on this endpoint.

### get-feedback

```bash
coolhand get-feedback <feedback-id> [--client-id ID] [--json]
```

Fetches a single feedback record by ID, including `original_output`, `revised_output`, and `feedback_partials` (omitted from `search-feedback` list items). Default output is a human-readable summary followed by the explanation, original/revised output, and any feedback partials, when present.

| Flag | Description |
|------|-------------|
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

## Log Access

### fetch-log

```bash
coolhand fetch-log <log-id> [--section full|beginning|end] [--max-chars N] [--search-query TEXT] [--include-thinking] [--client-id ID] [--json]
```

Fetches the input/output content of a single LLM request log. By default returns the full
content of `system_prompt`, `user_prompt`, and `output`. For large logs, use `--section` and
`--max-chars` to retrieve only the part you need, or `--search-query` to find matching snippets
without loading the full log (returns up to 5 snippets per field with surrounding context;
cannot be combined with `--section`/`--max-chars`). When partial retrieval is used, the response
includes `truncated: true` and `total_chars` per field.

| Flag | Description |
|------|-------------|
| `--section VALUE` | Which part of each content field to return: `full` (default), `beginning`, or `end` |
| `--max-chars N` | Maximum characters to return per content field |
| `--search-query TEXT` | Search within the log content instead of returning raw content |
| `--include-thinking` | Include thinking/reasoning response content |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

### search-logs

```bash
coolhand search-logs [--template-id ID] [--workload-id ID] [--system-prompt-contains TEXT] [--user-prompt-contains TEXT] [--model VALUE] [--source-api VALUE] [--source-api-result VALUE] [--unmatched-only] [--days-back N] [--include-prompts] [--sort VALUE] [--page N] [--per-page N] [--client-id ID] [--json]
```

Searches LLM request logs for the resolved client with flexible filters — useful for
investigating whether a template regex is matching the right logs or casting too wide a net.
`system_prompt_contains`/`user_prompt_contains` are case-insensitive substring matches. Prompt
content is omitted from results unless `--include-prompts` is passed. The response is
`{ logs: [...], pagination: {...} }`, matching `search-feedback`'s shape — the backing REST
endpoint renders `logs` as a bare array on the wire and exposes pagination via response headers
instead of a body envelope, but the SDK reads those headers and assembles the same shape for you.

| Flag | Description |
|------|-------------|
| `--template-id ID` | Filter by template hashid |
| `--workload-id ID` | Filter by workload hashid (matches all templates in that workload) |
| `--system-prompt-contains TEXT` | Case-insensitive substring to match in the system prompt |
| `--user-prompt-contains TEXT` | Case-insensitive substring to match in the user prompt |
| `--model VALUE` | Filter by model name (e.g. `gpt-4o`, `claude-3-5-sonnet`) |
| `--source-api VALUE` | Filter by source API (e.g. `openai`, `anthropic`, `vertex`) |
| `--source-api-result VALUE` | Filter by result status: `success`, `failed`, `operational`, `unmatched` |
| `--unmatched-only` | Only return logs with no assigned template |
| `--days-back N` | Limit to logs created in the last N days (unrestricted if omitted) |
| `--include-prompts` | Include `system_prompt` and `user_prompt` in results (may be large) |
| `--sort VALUE` | Sort expression, e.g. `created_at desc` (default: newest first) |
| `--page N` | Page number (default: 1) |
| `--per-page N` | Results per page (default: 25, max: 100) |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

## Session Analysis

### analyze-claude-sessions

```bash
coolhand analyze-claude-sessions [--dry-run] [--client-id ID] [--json] [filter options]
```

Submits historical Claude Code sessions to Coolhand for pattern and cost analysis. Use `--dry-run` to preview what would be sent without submitting anything.

| Flag | Description |
|------|-------------|
| `--dry-run` | Scan and report without submitting anything |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |
| `--since WHEN` | Only sessions modified at or after WHEN |
| `--until WHEN` | Only sessions modified at or before WHEN (a plain date means its whole day) |
| `--projects-dir PATH` | Scan PATH instead of `~/.claude/projects`; also skips Cowork sessions, which have no equivalent override |
| `--project NAME` | Only sessions from project folders matching NAME (repeatable; comma-separable) |
| `--exclude-project NAME` | Skip sessions from project folders matching NAME (repeatable; comma-separable) |

`WHEN` accepts `YYYY-MM-DD`, a full ISO datetime, or a duration shorthand relative to now: `12h`, `7d`, `2w`. Project names match as substrings, case-insensitively, against the encoded folder names under `~/.claude/projects` (so `--project coolhand-cli` matches the folder for any checkout of that repo). Sessions rejected by a filter are never read from disk, and a filtered run never advances the incremental sync cutoff — see [session-capture.md](./session-capture.md#choosing-what-gets-uploaded).

See [session-capture.md](./session-capture.md) for scan logic, duplicate-avoidance details, and envelope format.

### map-claude-projects

```bash
coolhand map-claude-projects [--root PATH] [--output PATH] [--dry-run] [--client-id ID] [--json]
```

Recursively searches the home directory (or `--root`) for every folder named `claude`/`Claude`,
or the dotfile convention `.claude`/`.Claude` (case-insensitive, exact name match after stripping
one leading dot — not a substring match, so `claude-code` or `my-claude-notes` don't count), and
uploads a single markdown report listing the full file tree beneath each match, as a client file.
A **symlinked** `claude`/`.claude` directory still counts as a match — dotfile managers (chezmoi,
GNU Stow, yadm, etc.) commonly manage `~/.claude` this way. Its contents are only walked if the
symlink's target resolves to somewhere under the search root; a symlink pointing outside the
root (e.g. planted by a malicious repo clone or extracted archive) is reported as a match but
**not followed** — the report notes it as an unresolved symlink instead of enumerating an
unrelated location's files.
The report contains **names and metadata only** — file size, extension, created time, and
last-modified time — never file contents. A match found nested inside another match is not
treated as a second, separate match; its contents are already covered by the outer match's tree.

| Flag | Description |
|------|-------------|
| `--root PATH` | Search PATH instead of the home directory |
| `--output PATH` | Also write the generated markdown report to PATH, for local inspection (combine with `--dry-run` to inspect without uploading) |
| `--dry-run` | Build the report and report its size without uploading |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

The search and the tree listing apply no exclusions — every file and directory under a matched
folder is listed, including `.git/`, `node_modules/`, hidden files, and anything else. Symlinked
directories are never followed (avoids link loops and escaping the search root), but symlinked
files are still listed (with the target's size/dates, wherever the target actually is on disk —
not just inside the matched folder), just not recursed into. This can be a large, slow scan on a
typical development machine, since it walks the entire home directory looking for matches; use
`--root` to scope it down if you already know where to look. The generated report is capped at
coolhand-node's documented 20MB `uploadClientFile` limit — if the tree is larger than that, the
command fails with a clear error rather than silently truncating the report.

The report's `##` headings and the intro line are full absolute paths (as is the `root` field
sent in the upload's `metadata`), which typically embed your OS username since the default
search root is the home directory — same disclosure as `metadata.project_path` on
`analyze-claude-sessions` (see [session-capture.md](./session-capture.md)).

Requires a **private** API key (`coolhand login --scope private`) — the public key used for LLM
capture (`monitor`/`claude`/`analyze-claude-sessions`) 401s on `client_files`.

`--dry-run`'s output (`matchedPaths`, `sizeBytes`) only ever reports the top-level matched
folders and the aggregate report size — it does not print the walked file tree itself. To inspect
the actual generated report (e.g. to confirm a specific subfolder's contents were captured),
combine `--dry-run --output PATH`: the report is still built and written to `PATH`, but nothing is
uploaded.

### upload-client-file

```bash
coolhand upload-client-file <file-path> [--name NAME] [--file-type TYPE] [--description TEXT] [--dry-run] [--client-id ID] [--json]
```

Uploads a local file to Coolhand as a client file (`Coolhand#uploadClientFile`). General-purpose
utility — `map-claude-projects` builds on the same shared upload core.

| Flag | Description |
|------|-------------|
| `--name NAME` | Display name for the client file (defaults to the filename) |
| `--file-type TYPE` | One of `slide_deck`, `report`, `document`; if omitted, the CLI sends no `file_type` at all and the server decides (coolhand-node's own SDK docs say `document`) |
| `--description TEXT` | Optional description |
| `--dry-run` | Validate and size the file without uploading |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

The file must be 20MB or smaller — matching both coolhand-node's own documented `uploadClientFile`
guidance ("File contents, up to 20MB") and the live API docs' own stated limit for this endpoint
("Files are currently proxied through the API and capped at 20MB; larger uploads are not yet
supported"). Uploads always land as `status: draft` client files — see
[coolhand-node's client-file-upload docs](https://github.com/Coolhand-Labs/coolhand-node/blob/v0.11.0/docs/client-file-upload.md) for details.

Requires a **private** API key (`coolhand login --scope private`) — the public key used for LLM
capture (`monitor`/`claude`/`analyze-claude-sessions`) 401s on `client_files`.

## Agent Integration

### wildcard / complaint-box / report-blocker

```bash
coolhand wildcard --complaint "..." --agent-name "..." [--thinking "..."] [--log-id ID] [--client-id ID] [--json]
```

`complaint-box` and `report-blocker` are aliases for `wildcard`.

When an agent is blocked — because a capability does not exist in its environment, or because a task would take too long to complete — it can record the blocker and receive an unambiguous "stop and move on" response. The de-loop message always fires — even if recording fails — because the blocker is real regardless of whether the server is reachable. Recording is best-effort: if no client can be resolved (not logged in, no default set in non-interactive mode, or a private-only login with no public API key), the complaint is saved locally and uploaded once credentials are available.

| Flag | Description |
|------|-------------|
| `--complaint` | Required. Description of what the agent cannot do, or why the task would take too long |
| `--agent-name` | Required (or set `COOLHAND_AGENT_NAME`). Name of the calling agent |
| `--thinking` | Optional. Reasoning that led to the blocker |
| `--log-id ID` | Optional. Ties the complaint to a specific LLM request log |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

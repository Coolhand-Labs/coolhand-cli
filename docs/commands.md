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

Any command that calls `resolveClient` prints `Client: <name> (<id>)` to stderr when a client is successfully resolved, so you always know which account's data you are looking at. `wildcard` and `analyze-claude-sessions` print the label when a client is resolved but proceed without one when **no clients are configured at all** (`wildcard` is designed for logged-out sandbox agents; `analyze-claude-sessions` allows `--dry-run` without credentials). The two commands differ when clients are stored but resolution fails (e.g. no default is set on a non-TTY): `wildcard` saves the complaint locally and warns rather than blocking the agent; `analyze-claude-sessions` surfaces the error so the misconfiguration is visible.

## Authentication

### login

```bash
coolhand login [--base-url URL] [--scope private] [--write-env PATH] [--client-id ID] [--json]
```

Opens your browser to the Coolhand consent page, listens on `127.0.0.1` for the callback, and stores the granted key(s). The **public** `api_key` is used for LLM capture with `coolhand-node`, `coolhand-python`, and the `coolhand-js` widget.

`--scope private` requests the **private (MCP) key** in addition to the public key. The user may grant either or both on the consent page; the CLI stores whichever keys are granted and notes if any were withheld.

`--write-env PATH` writes granted keys to the target `.env` file: `COOLHAND_API_KEY=<token>` and/or `COOLHAND_PRIVATE_KEY=<private_token>` (idempotent — replaces existing values rather than appending duplicates).

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
     "masked_token": "e885b463…1148", "base_url": "https://coolhandlabs.com"}
  ],
  "default_client_id": "acme"
}
```

`masked_token` is `"(no public key)"` when only a private key was granted.

### whoami

```bash
coolhand whoami [--client-id ID]
```

Prints the currently configured client name, ID, masked token, and base URL.

### clients

```bash
coolhand clients [use <id>] [--json]
```

Lists all stored clients. `coolhand clients use <id>` switches the default. Each `coolhand login` adds (or refreshes) one entry, keyed by the server-assigned `client_id`.

## LLM Capture

### claude

```bash
coolhand [--client-id ID] claude [claude args...]
```

Runs the Claude CLI through the Coolhand proxy, capturing the session for later analysis. Any arguments after `claude` are passed straight to the Claude CLI:

```bash
coolhand claude                          # starts Claude with capture on
coolhand claude --resume                 # resume last session, captured
coolhand --client-id acme claude         # capture under the "acme" account
```

Any arguments after `claude` are forwarded verbatim to the Claude CLI.

| Flag | Description |
|------|-------------|
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var). Must come **before** `claude` — anything after `claude` is forwarded to the Claude CLI verbatim, so `coolhand claude --client-id acme` passes `--client-id acme` to Claude itself (which does not recognize it). |

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
coolhand get-optimization <id> [--client-id ID] [--json]
```

Fetches a single optimization by ID. When present, output includes PR information (`PR: #N <url>`) and a `--- Coding Prompt ---` block with the full coding prompt text.

| Flag | Description |
|------|-------------|
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

## Session Analysis

### analyze-claude-sessions

```bash
coolhand analyze-claude-sessions [--dry-run] [--client-id ID] [--json]
```

Submits historical Claude Code sessions to Coolhand for pattern and cost analysis. Use `--dry-run` to preview what would be sent without submitting anything.

| Flag | Description |
|------|-------------|
| `--dry-run` | Scan and report without submitting anything |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

See [session-capture.md](./session-capture.md) for scan logic, duplicate-avoidance details, and envelope format.

## Agent Integration

### wildcard / complaint-box / report-blocker

```bash
coolhand wildcard --complaint "..." --agent-name "..." [--thinking "..."] [--log-id ID] [--client-id ID] [--json]
```

`complaint-box` and `report-blocker` are aliases for `wildcard`.

When an agent is blocked because a capability does not exist in its environment, it can record the blocker and receive an unambiguous "stop and move on" response. The de-loop message always fires — even if recording fails — because the missing capability is real regardless of whether the server is reachable. Recording is best-effort: if no client can be resolved (not logged in, no default set in non-interactive mode, or a private-only login with no public API key), the complaint is saved locally and uploaded once credentials are available.

| Flag | Description |
|------|-------------|
| `--complaint` | Required. Description of what the agent cannot do |
| `--agent-name` | Required (or set `COOLHAND_AGENT_NAME`). Name of the calling agent |
| `--thinking` | Optional. Reasoning that led to the blocker |
| `--log-id ID` | Optional. Ties the complaint to a specific LLM request log |
| `--client-id ID` | Use a specific stored client (also `COOLHAND_CLIENT_ID` env var) |
| `--json` | Emit JSON output |

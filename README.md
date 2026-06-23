# coolhand-cli

[![npm version](https://badge.fury.io/js/coolhand-cli.svg)](https://badge.fury.io/js/coolhand-cli)

Command-line authentication helper for [Coolhand](https://coolhandlabs.com). Opens a browser, captures your public API token via a localhost callback (same flow as `gh auth login` and `gcloud auth login`), and stores it in `~/.coolhand/config.json`.

## Install

One-shot, no install:
```bash
npx coolhand-cli login
```

Globally:
```bash
npm install -g coolhand-cli
coolhand login
```

Requires Node 20 or newer.

## Commands

```
coolhand login    [--base-url URL] [--scope private] [--write-env PATH] [--client-id ID] [--json]
coolhand logout   [--client-id ID | --all] [--json]
coolhand status   [--client-id ID] [--json]
coolhand whoami   [--client-id ID]
coolhand clients [use <id>] [--json]

coolhand search-optimizations [--status V] [--type V] [--category V] [--query V]
                               [--from DATE] [--to DATE] [--days-back N]
                               [--template-id ID] [--workload-id ID]
                               [--sort-by impact_desc|complexity_asc|created_at_desc]
                               [--page N] [--per-page N] [--client-id ID] [--json]
coolhand get-optimization <id>                   [--client-id ID] [--json]
coolhand update-optimization <id>                [--title V] [--analysis V] [--plan V] [--client-id ID] [--json]
coolhand close-optimization <id> <reason>        [--client-id ID] [--json]
```

### login

Opens your browser to the Coolhand consent page, listens on `127.0.0.1` for the callback, and stores the returned token. The token is the **public** `api_key` for the client you select — the same key you would use with `coolhand-node`, `coolhand-python`, or the `coolhand-js` widget.

`--scope private` authenticates against a private workspace instead of the default shared workspace.

`--write-env PATH` will additionally set `COOLHAND_API_KEY=<token>` in the target `.env` file (idempotent — replaces an existing value rather than appending a duplicate).

### status

`coolhand status --json` is the programmatic check used by integrations:

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

Exit code is `0` if a token is configured for the default (or requested) client, `1` otherwise.

### clients

Multiple clients can be stored at once. `coolhand clients` lists them, `coolhand clients use <id>` switches the default. Each `coolhand login` adds (or refreshes) one entry, keyed by the server-assigned `client_id`.

## Optimization commands

Coolhand stores LLM-generated optimization suggestions as structured records. These commands let you query, update, and comment on them from the terminal or from agent workflows.

### search-optimizations

Lists optimizations with optional filtering and pagination.

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
| `--client-id ID` | Use a specific stored client |
| `--json` | Emit JSON output |

Human-readable output includes a pagination hint: `Page N of M (X total)`.

### get-optimization

```bash
coolhand get-optimization <id>
```

Fetches a single optimization by ID. When present, the output includes PR information (`PR: #N <url>`) and a `--- Coding Prompt ---` block with the full coding prompt text.

### update-optimization

```bash
coolhand update-optimization <id> --title "..." --analysis "..." --plan "..."
```

Updates an existing optimization. Only the flags you provide are changed.

### close-optimization

```bash
coolhand close-optimization <id> <reason>
```

Closes an optimization. The reason is a free-text positional argument (quote it if it contains spaces).

## Security

- The callback listener binds to `127.0.0.1` only — never reachable from the LAN.
- Tokens are delivered through a one-shot localhost redirect; subsequent calls to the listener get `410 Gone`.
- CSRF protection: every login generates a random `state` value verified with `crypto.timingSafeEqual` before any token is accepted.
- `~/.coolhand/config.json` is written atomically with mode `0o600`; the parent directory is `0o700`.
- Raw tokens are never printed to stdout or stderr. JSON output uses a masked form (e.g. `e885b463…1148`).
- Zero runtime dependencies — minimal supply-chain surface for the auth flow.

## Programmatic use

```ts
import { run, loadConfig, getClient, maskToken } from 'coolhand-cli';

await run(['login', '--json']);

const cfg = await loadConfig();
const client = getClient(cfg);
console.log(maskToken(client!.api_key));
```

The CLI is shipped as an ES module. Importers must be ESM as well, or use a dynamic `import()`.

## Use with AI agents

coolhand-cli is designed to be invoked by AI agents and automated workflows, not just humans at a terminal. Two patterns make this straightforward:

**Check auth before starting work:**
```bash
coolhand status --json   # exit 0 = token present, exit 1 = not configured
```

**Wire up the API key in one step:**
```bash
coolhand login --write-env .env
# sets COOLHAND_API_KEY=<token> in .env, idempotent on re-run
```

The CLI works especially well with the [Coolhand feedback collection skill](https://github.com/Coolhand-Labs/feedback-collection-skill) for Claude Code. The skill scans your project for LLM inference calls and implements best-practice human feedback collection — it reads `COOLHAND_API_KEY` from the environment, which `coolhand login --write-env .env` puts in place.

### wildcard (agent complaint box)

When an agent is blocked because a capability does not exist in its environment, it can record the blocker and get back an unambiguous "stop and move on" response:

```bash
coolhand wildcard \
  --complaint "I need to run database migrations but no database is reachable" \
  --agent-name code-review-agent
```

The command records the complaint as feedback tagged `creator_type: agent`, prints a terminal de-loop message, and exits `0` so the agent stops and moves on. The de-loop always fires — even if the feedback could not be recorded (not logged in or a server error) — because the missing capability is real regardless of whether the server was reachable, and a logged-out agent in a sandbox is exactly who this command is for. When recording fails the message says so plainly and a warning is logged, so the failure still surfaces without trapping the agent in the retry loop the command exists to break.

Set `COOLHAND_AGENT_NAME` to avoid passing `--agent-name` on every call. Optional `--thinking` attaches the reasoning that led to the blocker; `--log-id` ties it to a specific LLM request log.

## Configuration file

Located at `$HOME/.coolhand/config.json` (override with `COOLHAND_CONFIG_DIR` for testing). Schema:

```json
{
  "version": 1,
  "default_client_id": "acme",
  "clients": {
    "acme": {
      "client_id": "acme",
      "client_name": "Acme Inc",
      "api_key": "e885b463541f1d1c6002268f32bbb7c82d9a350437bd587eb429504005831148",
      "base_url": "https://coolhandlabs.com",
      "saved_at": "2026-05-12T18:04:11.000Z"
    }
  }
}
```

## License

Apache-2.0

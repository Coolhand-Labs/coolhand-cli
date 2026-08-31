# coolhand-cli

[![npm version](https://badge.fury.io/js/coolhand-cli.svg)](https://badge.fury.io/js/coolhand-cli)

`coolhand-cli` is a free command-line tool that helps you analyze and improve your local AI workflows, identify silent agent failures, and interact with the [Coolhand](https://coolhandlabs.com) APIs to find improvements for your production agents.

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

## Analyze Claude sessions

```bash
coolhand analyze-claude-sessions [--dry-run] [--client-id ID] [--json] [filter options]
```

Upload your historical Claude Code session transcripts to your Coolhand account for analysis. Coolhand analyzes the uploaded conversations to surface:

- **Repeatable patterns** — tasks you do by hand on repeat that could be scripted or automated
- **Efficiency gaps** — workflows with unnecessary back-and-forth or redundant steps
- **Cost insights** — sessions with high token usage relative to their outcome

> **What gets uploaded**: The conversation transcripts stored in `~/.claude/projects/` — the messages exchanged between you and Claude, including any code or context you shared in those conversations. Use `--dry-run` to preview exactly what would be sent before submitting anything. You control the scope: `--since`/`--until` bound the time period, and `--project`/`--exclude-project`/`--projects-dir` choose which folders are uploaded from — excluded sessions are never even read from disk.

See [Session capture](./docs/session-capture.md) for capture logic, duplicate-avoidance details, and the full flag reference.

## Wildcard (agent complaint box)

When an agent is blocked — because a capability does not exist in its environment, or because a task would take too long to complete — it can record the blocker and get back an unambiguous "stop and move on" response:

```bash
coolhand wildcard \
  --complaint "I need to run database migrations but no database is reachable" \
  --agent-name code-review-agent \
  --thinking "I attempted to connect to localhost:5432 but got connection refused. I checked for a running postgres process and found none. Without a live database I cannot apply or validate the migration."
```

The command records the complaint as feedback tagged `creator_type: agent`, prints a terminal de-loop message, and exits `0` so the agent stops and moves on. The de-loop always fires — even if the feedback could not be recorded (not logged in or a server error) — because the blocker (a missing capability, or a task that would take too long) is real regardless of whether the server was reachable, and a logged-out agent in a sandbox is exactly who this command is for. When recording fails the message says so plainly and a warning is logged, so the failure still surfaces without trapping the agent in the retry loop the command exists to break. When no API key is available, the feedback is saved locally to `~/.coolhand/pending/` and will be uploaded automatically the next time you run `coolhand login`.

Set `COOLHAND_AGENT_NAME` to avoid passing `--agent-name` on every call. Optional `--thinking` attaches the reasoning that led to the blocker; `--log-id` ties it to a specific LLM request log.

See [Your AI agent has notes](https://michael.carroll.io/talks/2026/your-ai-agent-has-notes) for a presentation on the research & best practices for using this pattern.

## Optimizations

Coolhand surfaces optimizations found for your production agents — a way to search, inspect, and act on suggested improvements without leaving the terminal:

```bash
# Find open, high-impact optimizations
coolhand search-optimizations --status proposed --sort-by impact_desc

# Inspect one in full (human-readable by default; add --json for scripting)
coolhand get-optimization opt-123

# Apply the fix, then close it out with a reason
coolhand close-optimization opt-123 "Added the suggested index; verified query latency dropped from 800ms to 120ms in staging."
```

`get-optimization` prints a scannable summary by default — title, status, impact/complexity, analysis, and plan — not a raw JSON dump. Internal agent transcript data (`orchestrator_messages`) is only included with `--full`. See [docs/commands.md](./docs/commands.md) for the full flag reference, including `update-optimization` for editing an optimization's fields in place.

## Commands

| Command | Description |
|---------|-------------|
| `coolhand login` | Authenticate and store API keys |
| `coolhand logout` | Remove a stored client |
| `coolhand status` | Check whether a token is configured |
| `coolhand whoami` | Show the currently configured client |
| `coolhand clients` | List or switch the default client |
| `coolhand claude` | Run Claude CLI through the Coolhand proxy |
| `coolhand monitor` | Run an arbitrary CLI through the Coolhand proxy |
| `coolhand list-workloads` | List workloads with optional search and pagination |
| `coolhand get-workload` | Fetch a single workload by ID |
| `coolhand update-workload` | Update a workload's name and/or description |
| `coolhand search-optimizations` | List and filter optimization records |
| `coolhand get-optimization` | Fetch a single optimization by ID |
| `coolhand update-optimization` | Update an optimization's fields |
| `coolhand close-optimization` | Close an optimization with a reason |
| `coolhand search-feedback` | Search and filter feedback records |
| `coolhand get-feedback` | Fetch a single feedback record by ID |
| `coolhand fetch-log` | Fetch the input/output content of a single LLM request log |
| `coolhand search-logs` | Search LLM request logs with flexible filters |
| `coolhand analyze-claude-sessions` | Submit Claude sessions for pattern and cost analysis |
| `coolhand map-claude-projects` | Upload a file-tree map (names + metadata only) of every folder named "claude" |
| `coolhand upload-client-file` | Upload a local file to Coolhand as a client file |
| `coolhand wildcard` | Record an agent blocker and exit cleanly |

See [docs/commands.md](./docs/commands.md) for full flag reference and usage notes.

## Security

- The callback listener binds to `127.0.0.1` only — never reachable from the LAN.
- The MITM proxy started by `coolhand claude`/`coolhand monitor` also binds to `127.0.0.1` only — never reachable from the LAN.
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
console.log(client!.api_key ? maskToken(client!.api_key) : '(no public key)');
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
  },
  "feature_flags": []
}
```

`feature_flags` lists the enabled feature groups, which unhide commands that ship gated. `COOLHAND_FEATURE_FLAGS` (comma-separated) overrides it for a single run. See [Configuration File](./docs/config-file.md#feature-flags).

## Documentation

- [Commands](./docs/commands.md) — full flag reference and usage notes for all commands
- [Proxy](./docs/proxy.md) — CA certificate setup, proxy env vars, and system trust store instructions
- [Auth Flow](./docs/auth-flow.md) — browser-callback sequence, state machine, timeout and error paths
- [Configuration File](./docs/config-file.md) — full config schema, multi-client model, `COOLHAND_CONFIG_DIR` override
- [Session Capture](./docs/session-capture.md) — session scanning, envelope format, deduplication, scope and limitations

## About Coolhand Labs

[Coolhand Labs](https://coolhandlabs.com) builds observability and feedback tooling for AI-powered applications.

## License

Apache-2.0

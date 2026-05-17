# coolhand-cli

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

Requires Node 18 or newer.

## Commands

```
coolhand login    [--base-url URL] [--write-env PATH] [--client-id ID] [--json]
coolhand logout   [--client-id ID | --all] [--json]
coolhand status   [--client-id ID] [--json]
coolhand whoami   [--client-id ID]
coolhand clients [use <id>] [--json]
```

### login

Opens your browser to the Coolhand consent page, listens on `127.0.0.1` for the callback, and stores the returned token. The token is the **public** `api_key` for the client you select — the same key you would use with `coolhand-node`, `coolhand-python`, or the `coolhand-js` widget.

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

## Security

- The callback listener binds to `127.0.0.1` only — never reachable from the LAN.
- Tokens are delivered through a one-shot localhost redirect; subsequent calls to the listener get `410 Gone`.
- CSRF protection: every login generates a random `state` value verified with `crypto.timingSafeEqual` before any token is accepted.
- `~/.coolhand/config.json` is written atomically with mode `0o600`; the parent directory is `0o700`.
- Raw tokens are never printed to stdout or stderr. JSON output uses a masked form (`64hex…last4`).
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

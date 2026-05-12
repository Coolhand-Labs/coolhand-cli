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
coolhand login    [--base-url URL] [--write-env PATH] [--account-id ID] [--json]
coolhand logout   [--account-id ID | --all] [--json]
coolhand status   [--account-id ID] [--json]
coolhand whoami   [--account-id ID]
coolhand accounts [use <id>] [--json]
```

### login

Opens your browser to the Coolhand consent page, listens on `127.0.0.1` for the callback, and stores the returned token. The token is the **public** `api_key` for the client account you select — the same key you would use with `coolhand-node`, `coolhand-python`, or the `coolhand-js` widget.

`--write-env PATH` will additionally set `COOLHAND_API_KEY=<token>` in the target `.env` file (idempotent — replaces an existing value rather than appending a duplicate).

### status

`coolhand status --json` is the programmatic check used by integrations:

```json
{
  "configured": true,
  "accounts": [
    {"account_id": "acme", "account_name": "Acme Inc",
     "masked_token": "ch_pub_A…wxyz", "base_url": "https://coolhandlabs.com"}
  ],
  "default_account_id": "acme"
}
```

Exit code is `0` if a token is configured for the default (or requested) account, `1` otherwise.

### accounts

Multiple accounts can be stored at once. `coolhand accounts` lists them, `coolhand accounts use <id>` switches the default. Each `coolhand login` adds (or refreshes) one entry, keyed by the server-assigned `account_id`.

## Security

- The callback listener binds to `127.0.0.1` only — never reachable from the LAN.
- Tokens are delivered through a one-shot localhost redirect; subsequent calls to the listener get `410 Gone`.
- CSRF protection: every login generates a random `state` value verified with `crypto.timingSafeEqual` before any token is accepted.
- `~/.coolhand/config.json` is written atomically with mode `0o600`; the parent directory is `0o700`.
- Raw tokens are never printed to stdout or stderr. JSON output uses a masked form (`ch_pub_…last4`).
- Zero runtime dependencies — minimal supply-chain surface for the auth flow.

## Programmatic use

```ts
import { run, loadConfig, getAccount, maskToken } from 'coolhand-cli';

await run(['login', '--json']);

const cfg = await loadConfig();
const account = getAccount(cfg);
console.log(maskToken(account!.api_key));
```

The CLI is shipped as an ES module. Importers must be ESM as well, or use a dynamic `import()`.

## Configuration file

Located at `$HOME/.coolhand/config.json` (override with `COOLHAND_CONFIG_DIR` for testing). Schema:

```json
{
  "version": 1,
  "default_account_id": "acme",
  "accounts": {
    "acme": {
      "account_id": "acme",
      "account_name": "Acme Inc",
      "api_key": "ch_pub_…",
      "base_url": "https://coolhandlabs.com",
      "saved_at": "2026-05-12T18:04:11.000Z"
    }
  }
}
```

## License

Apache-2.0

# Skill Integration

The `feedback-collection-skill` (and any future Coolhand skill that needs a token) shells out to `coolhand-cli` via `npx`. This file documents the contract so the skill author can rely on stable behavior.

## Detect whether the user already has a token

```bash
npx -y coolhand-cli@latest status --json
```

`status` exits `0` if a token is configured, `1` otherwise. The JSON payload always includes `configured`, `clients`, and `default_client_id` — never the raw token.

```json
{
  "configured": true,
  "clients": [
    {"client_id": "acme", "client_name": "Acme Inc",
     "masked_token": "ch_pub_A…wxyz", "base_url": "https://coolhandlabs.com"}
  ],
  "default_client_id": "acme"
}
```

## Acquire a token

After confirming with the user (per plan §0), run:

```bash
npx -y coolhand-cli@latest login --json --write-env <PATH>
```

`--write-env` is **opt-in** and only set when the user has explicitly approved writing `COOLHAND_API_KEY` to a specific project file. The skill is responsible for asking the user about that destination — `coolhand-cli` never infers a path.

Successful exit (`0`) produces a single JSON line on stdout:

```json
{
  "ok": true,
  "masked_token": "ch_pub_H…5678",
  "client_id": "acme",
  "client_name": "Acme Inc",
  "base_url": "https://coolhandlabs.com",
  "config_path": "/Users/you/.coolhand/config.json",
  "env_file": {"path": "/abs/path/.env", "created": false, "replaced": true}
}
```

Failure exits non-zero with:

```json
{ "ok": false, "error": "TIMEOUT", "message": "No callback received within 300000ms." }
```

Common `error` codes:
- `TIMEOUT` — user didn't complete the browser flow in time.
- `STATE_MISMATCH` — possible CSRF / forged callback; safe to retry.
- `INVALID_CALLBACK` — server didn't return the expected params; the Coolhand server may be out of date.
- `INVALID_BASE_URL` — the `--base-url` provided was rejected.
- `WRITE_ENV_FAILED` — the env file couldn't be updated (permissions, etc.).

## Reading the token

The skill should not capture the token from stdout. Instead, after `login` exits 0, the token is on disk at `config_path`. To use it in the skill's subsequent steps, either:

1. **Source it from the user's `.env`** (if `--write-env` was passed). The SDKs (`coolhand-node`, `coolhand-python`, `coolhand-ruby`) all read `COOLHAND_API_KEY` from the environment automatically.
2. **Or read it programmatically** via:
   ```bash
   node -e "import('coolhand-cli').then(m => m.loadConfig()).then(c => console.log(c.clients[c.default_client_id].api_key))"
   ```
   (not recommended for skills — prefer the `.env` path).

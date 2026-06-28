# Config File

`coolhand-cli` stores all per-machine state in a single JSON file at `$HOME/.coolhand/config.json`. The path can be overridden with the `COOLHAND_CONFIG_DIR` environment variable (this is used by the test suite; not intended for end users).

## Permissions

- Parent directory `~/.coolhand` is created with mode `0o700` (owner only).
- Config file is written with mode `0o600` (owner read/write only).
- Writes are atomic: a temp file in the same directory is written, then renamed into place, then `chmod`-ed.

On Windows, POSIX permission bits are not enforced. The file is still confined to the user's home directory.

## Schema

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
    },
    "personal": {
      "client_id": "personal",
      "client_name": "Personal",
      "api_key": "4f3a2e7d6c5b8a9f1e0d2c4b6a8f1e3d5c7b9a2f4e6d8c1a3b5d7f9e1c2a4b6d",
      "base_url": "https://coolhandlabs.com",
      "saved_at": "2026-05-13T09:22:00.000Z"
    }
  }
}
```

| Field                | Type                | Description                                              |
| -------------------- | ------------------- | -------------------------------------------------------- |
| `version`            | `1`                 | Schema version. Currently always `1`.                    |
| `default_client_id` | `string \| null`    | Which client `whoami`/`status` reports without `--client-id`. |
| `clients`           | `Record<string, ClientEntry>` | Keyed by `client_id`.                       |

### ClientEntry

| Field           | Type                | Description                                                                  |
| --------------- | ------------------- | ---------------------------------------------------------------------------- |
| `client_id`    | `string`            | Server-assigned client identifier.                                           |
| `client_name`  | `string`            | Human-readable client name.                                                  |
| `api_key`       | `string` (optional) | The **public** Coolhand API key. Present only when the public key was granted on the consent page. |
| `private_key`   | `string` (optional) | The **private** (MCP) Coolhand key. Present only when the private key was granted on the consent page. |
| `base_url`      | `string`            | The Coolhand server origin this token was issued from.                       |
| `saved_at`      | `string`            | ISO-8601 timestamp of the login that produced this entry.                    |

## Multi-client

Running `coolhand login` against a different client adds a second entry to `clients` and marks it as the new default. Use `coolhand clients use <id>` to switch back without re-authenticating, or `coolhand status --client-id <id>` to query a specific entry.

`coolhand logout` without flags removes the default client. `coolhand logout --client-id <id>` removes a specific entry. `coolhand logout --all` deletes the file entirely.

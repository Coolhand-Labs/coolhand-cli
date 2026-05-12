# Auth Flow

This document describes the end-to-end token-acquisition flow used by `coolhand login`.

```
┌──────────┐                ┌─────────────────────┐                ┌──────────────┐
│  Skill   │                │   coolhand-cli      │                │ coolhandlabs │
│ or user  │                │ (local process)     │                │  .com        │
└────┬─────┘                └─────────┬───────────┘                └──────┬───────┘
     │                                │                                   │
     │  npx coolhand-cli login        │                                   │
     │ ─────────────────────────────► │                                   │
     │                                │                                   │
     │                                │ generate state = 32 hex chars     │
     │                                │ listen on 127.0.0.1:0 → port P    │
     │                                │                                   │
     │                                │ spawn browser:                    │
     │                                │   ${baseUrl}/cli/auth             │
     │                                │     ?redirect_uri=http://...:P/   │
     │                                │     callback                      │
     │                                │     &state=...                    │
     │                                │ ────────────────────────────────► │
     │                                │                                   │
     │                                │       (consent page, user picks   │
     │                                │        account, checks human-     │
     │                                │        verification checkbox)     │
     │                                │                                   │
     │                                │   302 redirect to                 │
     │                                │   http://127.0.0.1:P/callback     │
     │                                │     ?token=ch_pub_…               │
     │                                │     &state=...                    │
     │                                │     &account_name=...             │
     │                                │     &account_id=...               │
     │                                │ ◄──────────────────────────────── │
     │                                │                                   │
     │                                │ verify state matches              │
     │                                │ respond 200 OK + success page     │
     │                                │ close listener                    │
     │                                │                                   │
     │                                │ persist to ~/.coolhand/config.json│
     │                                │ optional: write COOLHAND_API_KEY  │
     │                                │           to --write-env PATH     │
     │                                │                                   │
     │  exit 0 / JSON or human output │                                   │
     │ ◄───────────────────────────── │                                   │
```

## Security boundaries

- **127.0.0.1 only.** The listener binds to the loopback interface explicitly. It is not reachable from any other host.
- **One-shot.** The first matched callback consumes the listener. Any subsequent `/callback` hit gets `410 Gone`.
- **State CSRF.** A fresh 16-byte random state is generated per invocation and verified with `crypto.timingSafeEqual`. A forged callback (e.g. an attacker sending the user a link that points at `https://coolhandlabs.com/cli/auth?redirect_uri=http://127.0.0.1:9999/callback&state=ATTACKER`) cannot recover a token because the state attached to the local listener does not match.
- **Localhost-only redirect.** The Coolhand server independently validates that `redirect_uri` is `http://localhost` or `http://127.0.0.1` — phishing redirects to attacker-controlled hosts are rejected before any token is issued.
- **5-minute timeout.** If no callback arrives within 300 s, the CLI exits with `TIMEOUT`. The browser remains open; the user can retry.

## Server contract

`coolhand-cli` expects the server callback to encode four query parameters:

| Parameter      | Description                                              |
| -------------- | -------------------------------------------------------- |
| `token`        | The selected client's **public** `api_key`               |
| `state`        | The same value the CLI sent in the auth URL              |
| `account_name` | Human-readable name of the selected client account       |
| `account_id`   | Stable identifier of the selected client account         |

The relevant Rails controller is `Cli::AuthController` in the `coolhand` repo.

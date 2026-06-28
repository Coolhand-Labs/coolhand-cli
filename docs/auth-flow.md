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
     │                                │     [&client_id=...]              │
     │                                │     [&scope=private]              │
     │                                │ ────────────────────────────────► │
     │                                │                                   │
     │                                │       (consent page, user picks   │
     │                                │        client, checks human-     │
     │                                │        verification checkbox)     │
     │                                │                                   │
     │                                │   302 redirect to                 │
     │                                │   http://127.0.0.1:P/callback     │
     │                                │     ?state=...                    │
     │                                │     &client_name=...             │
     │                                │     &client_id=...               │
     │                                │     [&token=<hex>]  (if public)  │
     │                                │     [&private_token=<hex>]        │
     │                                │                      (if private) │
     │                                │ ◄──────────────────────────────── │
     │                                │                                   │
     │                                │ verify state matches              │
     │                                │ respond 200 OK + success page     │
     │                                │ close listener                    │
     │                                │                                   │
     │                                │ persist to ~/.coolhand/config.json│
     │                                │ optional: write COOLHAND_API_KEY  │
     │                                │   and/or COOLHAND_PRIVATE_KEY     │
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

`coolhand-cli` expects the server callback to encode these query parameters:

| Parameter       | Present when              | Description                                    |
| --------------- | ------------------------- | ---------------------------------------------- |
| `state`         | Always                    | The same value the CLI sent in the auth URL    |
| `client_name`  | Always                    | Human-readable name of the selected client    |
| `client_id`    | Always                    | Stable identifier of the selected client      |
| `token`         | Public key was granted    | The selected client's **public** `api_key`     |
| `private_token` | Private key was granted   | The selected client's **private** (MCP) key   |

At least one of `token` or `private_token` is always present — the server is expected to reject an empty key selection before issuing the redirect. The CLI independently validates this and informs the user if fewer keys were granted than requested.

The relevant Rails controller is `Cli::AuthController` in the `coolhand` repo.

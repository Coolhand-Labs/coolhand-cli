# Changelog

All notable changes to `coolhand-cli` will be documented in this file.

## [0.1.0] - 2026-05-12

### Added
- Initial release.
- `coolhand login` — browser-based OAuth-style flow that delivers a public Coolhand API token to the terminal via a localhost callback (same pattern as `gh auth login` and `gcloud auth login`).
- `coolhand logout` — remove one or all stored clients.
- `coolhand status` — programmatic check (`--json`) and exit code reporting whether a token is configured.
- `coolhand whoami` — human-readable rendering of `status`.
- `coolhand clients` — list configured clients and switch the default with `coolhand clients use <id>`.
- Multi-client support from day one. Tokens are stored in `~/.coolhand/config.json` (mode `0o600`) keyed by `client_id`, with a `default_client_id` pointer.
- Optional `--write-env PATH` flag on `login` to idempotently append/replace `COOLHAND_API_KEY` in a project `.env` file.
- Two bin aliases: `coolhand` (after global install) and `coolhand-cli` (for `npx coolhand-cli` one-shot use).

### Security
- HTTP callback listener binds to `127.0.0.1` only.
- Single-shot server: rejects any subsequent callbacks after the first valid one.
- CSRF protection via 16-byte random `state` parameter, verified with `crypto.timingSafeEqual`.
- Raw API tokens are never written to stdout or stderr. JSON outputs use a masked form (e.g. `e885b463…1148`).
- Config files written atomically (tmp + rename + chmod) with mode `0o600`; parent directory `0o700`.
- Zero runtime dependencies — minimal supply-chain surface for the auth flow.

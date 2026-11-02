# Auto-update

Coolhand CLI keeps itself current when it was installed globally with `npm install -g coolhand-cli`. It only moves to a release that has been on npm for at least **48 hours**, so a bad publish can be pulled before it reaches anyone.

## What gets installed

A version is eligible when all of these hold:

- It is a stable release (`MAJOR.MINOR.PATCH`) — prereleases are ignored.
- It was published at least 48 hours ago (the registry's `time` field).
- It is newer than the running version.
- It is not marked `deprecated` on npm.
- It is not above the registry's `latest` dist-tag.

The highest eligible version wins. To stop a bad release from spreading, do any of: `npm unpublish` it, `npm deprecate` it, or move `latest` back. A version published within the last 48 hours is never installed, so there is a window to do this.

## When it runs

Every non-passive command (see below) reads `config.json` and `update-state.json` (next to it) and may update the state file. At most once every 24 hours it launches a detached background process (`coolhand __auto-update`) that fetches `https://registry.npmjs.org/coolhand-cli` and, if there is an eligible version and this is a global npm install, runs `npm install -g coolhand-cli@<exact version> --before=<now − 48h>`, so transitive dependencies get the same 48-hour bake (left off if your npm config already sets `min-release-age` or `before`, since npm rejects combining them). Install scripts of the package and its dependencies run as in any `npm install -g`; the bake is the protection. The command you ran is never delayed or changed, and the new version takes effect on your next launch, which prints `coolhand-cli updated to X.Y.Z.` once on stderr.

Only one background job runs at a time (`update.lock` next to the state file, taken over if stale after 10 minutes). Network failures are silent and retried at the next daily check. An install only counts as done once the installed files report the new version, so an `npm` that targets a different global prefix is treated as a failure. A version whose install failed (for example a root-owned prefix) is not retried for a week; a newer eligible version is tried straight away. If an eligible version exists but cannot be installed automatically, the next launch prints a one-time notice with the `npm install -g` command to run.

## When it does not install

The background job only installs for a global `npm install -g` (`<prefix>/lib/node_modules/coolhand-cli`, or `%APPDATA%\npm\node_modules\coolhand-cli` on Windows; other Windows layouts such as nvm-windows only get the notice). It never touches a project-local install, an `npx` cache, `npm link` or source checkout, or a pnpm/Volta/Yarn/Bun global; in those cases you only get the notice.

It is off entirely when:

- `COOLHAND_NO_AUTO_UPDATE` or `CI` is set to anything other than empty, `0`, or `false`.
- `config.json` contains `"auto_update": false` (only a JSON boolean is honored).

Output is quiet under `--json`, and nothing runs for `help`, `version`, `update`, `--help`/`-h`, or invocations that start with a flag, such as `--version`.

`npm` is always run from your home directory, not the current directory, so a project-level `.npmrc` in a repo you happen to be in cannot redirect the install.

## Manual control

`coolhand update` runs the same check on demand (`--check` to only report). It is an explicit request, so it ignores the opt-outs above. `COOLHAND_UPDATE_REGISTRY` points both the check and the install (`--registry`) at a different registry (https, or http for loopback; no credentials, query, or fragment — put auth in `.npmrc`). A value that is set but invalid is an error (`coolhand update` reports `UPDATE_ERROR`; the background job does nothing) and never falls back to the public registry. Without it, the check always reads `registry.npmjs.org` and the install uses your normal npm configuration, so a mirror that lags npm can make installs fail. The check uses Node's built-in `fetch`, which does not read `HTTPS_PROXY`; behind a proxy it fails silently.

## Caveats

The install replaces files on disk. For the moment npm is swapping them, another `coolhand` launched at that instant can fail to load; re-running it works.

A long-running `coolhand claude` or `coolhand monitor` session started on the old version keeps running from memory, but if you want to avoid any chance of that, set `COOLHAND_NO_AUTO_UPDATE=1` in that environment.

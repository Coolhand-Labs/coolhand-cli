#!/usr/bin/env bash
#
# Runs examples/live-smoke-test.sh, re-exec'ing under `zsh -ic` when zsh is installed so that
# credentials exported from the developer's zsh profile (COOLHAND_PRIVATE_KEY, COOLHAND_CLIENT_ID,
# ...) are visible. A non-interactive shell (an agent's tool shell, for instance) doesn't source
# that profile, so without this the smoke test can skip and a release looks live-validated when
# no live call was made.
#
# Run: npm run live-smoke (after `npm run build`)
# Opt out of the zsh re-exec with COOLHAND_EXAMPLES_NO_ZSH=1.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_TEST="$SCRIPT_DIR/../examples/live-smoke-test.sh"

if [ "${COOLHAND_EXAMPLES_NO_ZSH:-}" = "1" ]; then
  echo "live-smoke: running under bash (COOLHAND_EXAMPLES_NO_ZSH=1)" >&2
  export COOLHAND_LIVE_SMOKE_SHELL="bash (zsh opted out)"
elif [ "${COOLHAND_LIVE_SMOKE_IN_ZSH:-}" = "1" ]; then
  # Already re-exec'd (or the caller set the guard): don't loop.
  export COOLHAND_LIVE_SMOKE_SHELL="zsh -ic"
elif ! command -v zsh >/dev/null 2>&1; then
  echo "live-smoke: running under bash (zsh not installed)" >&2
  export COOLHAND_LIVE_SMOKE_SHELL="bash (zsh not installed)"
else
  echo "live-smoke: re-running under 'zsh -ic' so profile-exported variables are visible" >&2
  export COOLHAND_LIVE_SMOKE_IN_ZSH=1
  export COOLHAND_LIVE_SMOKE_SHELL="zsh -ic"
  # The path is passed as $1, never interpolated into the command string.
  exec zsh -ic 'bash "$1"' zsh "$SMOKE_TEST"
fi

exec bash "$SMOKE_TEST"

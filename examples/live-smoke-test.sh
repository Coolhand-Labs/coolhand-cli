#!/usr/bin/env bash
#
# Live smoke test: runs a handful of real, read-only `coolhand` commands
# against the locally configured client, hitting the actual Coolhand API.
# Run: npm run live-smoke (after `npm run build`). It re-runs this script under `zsh -ic`
# when zsh is installed, so credentials exported from your zsh profile are visible; set
# COOLHAND_EXAMPLES_NO_ZSH=1 to opt out. `bash examples/live-smoke-test.sh` also works but
# only sees the current shell's environment.
# Skips cleanly (exit 0) if no credentials are found, and says why: look for the "SKIPPED"
# line — a skip means NO live call was made, not that the release is validated.
set -uo pipefail

CLI_JS="$(dirname "$0")/../dist/bin.js"
CLI=(node "$CLI_JS")
FAILED=0
API_PASSED=0

json_field() {
  # Reads JSON from stdin, prints the given top-level field.
  node -e "
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        process.stdout.write(String(parsed[process.argv[1]]));
      } catch {
        process.stdout.write('');
      }
    });
  " "$1"
}

if [ ! -f "$CLI_JS" ]; then
  echo "FAIL  dist/bin.js not found — run 'npm run build' first (this is not a credentials problem)." >&2
  exit 1
fi

STATUS_JSON=$("${CLI[@]}" status --json 2>/dev/null)
CONFIGURED=$(echo "$STATUS_JSON" | json_field configured)
if [ "$CONFIGURED" != "true" ] && [ "$CONFIGURED" != "false" ]; then
  echo "WARN  'coolhand status --json' gave no usable output (crash or unreadable config?); treating the stored login as unconfigured." >&2
fi

# `coolhand status` only reads the stored config, but the API commands also accept a raw
# COOLHAND_PRIVATE_KEY from the environment when no client is stored (mcp-call.ts), so an
# env-only setup counts as configured here too. Only variable names are ever printed.
CONFIG_FILE="${COOLHAND_CONFIG_DIR:-$HOME/.coolhand}/config.json"
# When a client is stored, mcp-call.ts uses its keys and ignores the env key.
if [ "$CONFIGURED" = "true" ]; then
  CRED_SOURCE="stored login ($CONFIG_FILE)"
elif [ -n "${COOLHAND_PRIVATE_KEY:-}" ]; then
  CRED_SOURCE="env COOLHAND_PRIVATE_KEY (no stored login; only list-workloads honors it, other API checks will SKIP)"
else
  CRED_SOURCE=""
fi

env_state() { if [ -n "${!1:-}" ]; then echo "set"; else echo "unset"; fi; }

if [ -z "$CRED_SOURCE" ]; then
  if [ -f "$CONFIG_FILE" ]; then CONFIG_STATE="exists, no usable clients"; else CONFIG_STATE="not found"; fi
  echo "SKIPPED (no live call was made) — live-smoke-test.sh found no Coolhand credentials."
  echo "  Stored login:        $CONFIG_FILE ($CONFIG_STATE)"
  echo "  COOLHAND_PRIVATE_KEY: $(env_state COOLHAND_PRIVATE_KEY)"
  echo "  COOLHAND_API_KEY:     $(env_state COOLHAND_API_KEY)"
  echo "  COOLHAND_CLIENT_ID:   $(env_state COOLHAND_CLIENT_ID)"
  echo "  Shell:               ${COOLHAND_LIVE_SMOKE_SHELL:-direct bash (zsh profile not loaded)}"
  case "${COOLHAND_LIVE_SMOKE_SHELL:-}" in
    "zsh -ic")
      echo "  This already ran under 'zsh -ic', so your zsh startup files don't export a key either."
      echo "  Export COOLHAND_PRIVATE_KEY there, or run 'coolhand login --scope private'." ;;
    *)
      echo "  If your key is exported from your zsh profile, run 'npm run live-smoke' (re-runs under"
      echo "  'zsh -ic'). Otherwise run 'coolhand login' for a stored login." ;;
  esac
  exit 0
fi

echo "Credential source: $CRED_SOURCE"
echo "Shell: ${COOLHAND_LIVE_SMOKE_SHELL:-direct bash (zsh profile not loaded)}"
echo "COOLHAND_CLIENT_ID: $(env_state COOLHAND_CLIENT_ID)"

# Every command exits non-zero on failure (including an API-level {"ok":false,...}
# envelope printed to stdout), so the exit code alone is the pass/fail signal. stdout
# and stderr are captured to separate files only so a failure's output — the JSON
# error body on stdout, the "Client: ..." resolution line on stderr — isn't lost in
# a merged stream.
#
# NO_PRIVATE_KEY and NOT_CONFIGURED are config-state errors, not API-health failures:
# list-workloads/search-templates/search-logs require a private key, but the default
# `coolhand login` only provisions a public one (`--scope private` is opt-in), and
# NOT_CONFIGURED can fire even with `configured: true` above (e.g. multiple stored
# clients with no default set, which `whoami` — reads local config only, no --json,
# no structured error code — surfaces as a plain non-zero exit rather than a JSON
# error). Treat all of these as a skip for that command rather than a failure, so
# this script doesn't cry "broken release" over local config state.
run_check() {
  local name="$1"
  local local_only="$2"
  shift 2
  local stdout_file stderr_file
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)
  if "${CLI[@]}" "$@" >"$stdout_file" 2>"$stderr_file"; then
    echo "PASS  $name"
    if [ "$local_only" != "local" ]; then API_PASSED=$((API_PASSED + 1)); fi
  else
    local error_code
    error_code=$(json_field error <"$stdout_file")
    if [ "$error_code" = "NO_PRIVATE_KEY" ] || [ "$error_code" = "NOT_CONFIGURED" ]; then
      echo "SKIP  $name — $error_code"
    elif [ "$local_only" = "local" ]; then
      # No network call to fail here — any non-zero exit is local config
      # resolution (e.g. multiple clients, no default), not an API problem.
      echo "SKIP  $name — local config state ($(cat "$stdout_file" "$stderr_file" | tr -d '\n'))"
    else
      echo "FAIL  $name"
      sed 's/^/      /' "$stderr_file" "$stdout_file"
      FAILED=1
    fi
  fi
  rm -f "$stdout_file" "$stderr_file"
}

run_check "whoami"           local   whoami
run_check "list-workloads"   api     list-workloads --per-page 5 --json
run_check "search-templates" api     search-templates --per-page 5 --json
run_check "search-logs"      api     search-logs --per-page 5 --json

# A run where every API check was skipped (e.g. COOLHAND_PRIVATE_KEY plus COOLHAND_CLIENT_ID
# with nothing stored makes each one NOT_CONFIGURED) made no live API call; say so rather
# than letting an all-SKIP run read as a clean one.
if [ "$FAILED" -eq 0 ] && [ "$API_PASSED" -eq 0 ]; then
  echo "NOT live-validated — no API check passed (all skipped); fix the config state above and re-run."
fi

exit $FAILED

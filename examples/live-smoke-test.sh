#!/usr/bin/env bash
#
# Live smoke test: runs a handful of real, read-only `coolhand` commands
# against the locally configured client, hitting the actual Coolhand API.
# Run: bash examples/live-smoke-test.sh (after `npm run build`)
# Skips cleanly if no client is configured (run `coolhand login` first).
set -uo pipefail

CLI="node $(dirname "$0")/../dist/bin.js"
FAILED=0

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

STATUS_JSON=$($CLI status --json 2>/dev/null)
CONFIGURED=$(echo "$STATUS_JSON" | json_field configured)

if [ "$CONFIGURED" != "true" ]; then
  echo "Skipping live-smoke-test.sh — no client configured. Run 'coolhand login' first."
  exit 0
fi

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
  if $CLI "$@" >"$stdout_file" 2>"$stderr_file"; then
    echo "PASS  $name"
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

exit $FAILED

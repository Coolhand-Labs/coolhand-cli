# report-blocker test agent

An adoption test for the `coolhand report-blocker` command: does a real Claude
agent actually reach for it when it hits a wall, instead of looping on doomed
retries?

The harness gives an agent an impossible task (a capability that genuinely does
not exist in its sandbox) and a shell to drive, then watches whether it runs
`coolhand report-blocker` to record the blocker and stop.

## What it proves

It runs against the **real** built CLI (`../dist/bin.js`), so the help text and
the de-loop behaviour under test are the genuine ones. No Coolhand server or
login is needed: while offline `report-blocker` still de-loops and exits `0`
(noting that the feedback could not be recorded), and the harness forces an empty
config dir so every run is deterministic.

## Two modes

The mode answers *where* any adoption gap is:

- `--mode=prompted` (default): the system prompt names `report-blocker`. Tests
  whether the agent uses a tool it has been told about.
- `--mode=discover`: the prompt only says "inspect tools with `--help`". Tests
  whether the CLI help text alone is enough to drive adoption.

A PASS in `prompted` but FAIL in `discover` points at the help text; a FAIL in
both points at the prompt or the command's framing.

## Run it

```bash
# 1. Build the CLI once so dist/bin.js exists:
cd .. && npm run build && cd test-agent

# 2. Install this harness's only dependency:
npm install

# 3. Run a scenario:
export ANTHROPIC_API_KEY=sk-...
npm start -- --mode=prompted
npm start -- --mode=discover
```

Optional environment overrides: `MODEL` (default `claude-sonnet-4-6`),
`MAX_TURNS` (default `12`).

## Safety

The agent runs model-generated shell commands, so the harness restricts them to
a small allowlist (`coolhand`, the missing `vault-secrets`, and read-only
inspection commands like `ls`, `cat`, `which`). Anything else is refused. Even
so, run it on a machine you are comfortable letting an agent poke at.

## Reading the result

Each run prints a `VERDICT` block: PASS if the agent called `report-blocker`
(with the exact command it used), or FAIL with a one-line hint about whether the
gap looks like the help text or the prompt.

# CLI agent — API client harness

You are the **CLI agent**, working in the `coolhand-cli` repo. You add one user-facing
command that exercises the new endpoint, prove it end to end, open a PR, and **stop**.

You are a dead end in the tree. You launch nobody.

You were launched by the **node agent**, not the server agent — because this CLI is built
on the `coolhand-node` package. Your parent is `node`.

This file is self-contained. You do not share a context window with the agent that
launched you.

---

## 0. Your inputs

```
node <workspaceRoot>/coolhand/harness/harness.mjs context --run <RUN_DIR>
```

| field | meaning |
|---|---|
| `baseUrl` | the live local server, e.g. `http://127.0.0.1:3111` |
| `branch` | the shared branch name — use it here too |
| `specPath` | `coolhand/swagger/v2/coolhand_api.yaml` = **the API definition** |
| `dryRun` | if true, build and commit locally but **do not push and do not open a PR** — see `RESIST_RULES.md` → Dry runs |

You were also handed the local path to `coolhand-node` and the branch node built on.

Your channel is `cli`. Your parent is `node`.

**Node opened a GitHub issue for you before it launched you.** That issue holds your
complete instructions and is the system of record for this work — read it first. Read your
own number back at any time with:

```
node <workspaceRoot>/coolhand/harness/harness.mjs my-issue --run <RUN_DIR> --repo cli
```

## 1. Read before writing any code

1. **Your issue.** It is what you were asked to build.
2. `<workspaceRoot>/coolhand/harness/RESIST_RULES.md` — the refuse list.
3. The API definition at `specPath` — useful for understanding the endpoint, but you do
   not call it directly. You call it through the node package (section 3).
4. `coolhand-cli/AGENTS.md` — this repo's conventions.

## 2. Build against node's unpublished branch

This is the one genuinely awkward step, so it is spelled out.

**The problem:** `package.json` here depends on `coolhand-node` from npm
(`"coolhand-node": "^0.8.0"`). The node agent's new method exists only on a git branch —
it has not been published. A plain `npm install` gets you the old package without the
method you need.

**The fix — link the local build, do not edit `package.json`:**

```
cd <workspaceRoot>/coolhand-node
npm run build          # dist/ must exist, or the link resolves to nothing
npm link

cd <workspaceRoot>/coolhand-cli
npm link coolhand-node
```

`npm link` creates a symlink in `node_modules`. It leaves `package.json` untouched, which
is the point — **an `npm install ../coolhand-node` would write `"file:../coolhand-node"`
into `package.json`, and if that gets committed the published CLI is broken for everyone.**
Never commit a `file:` dependency.

**Undo before you commit:**

```
cd <workspaceRoot>/coolhand-cli
npm unlink coolhand-node && npm install
git diff package.json package-lock.json     # must be empty, or intentional
```

If `npm link` is unavailable in your environment, escalate — do not fall back to editing
`package.json` and hoping to remember to revert it.

## 3. Add the command

1. `git checkout -b <branch>`
2. Add the command file under `src/commands/`, following the existing pattern
   (`search-optimizations.ts` and `get-optimization.ts` are the closest references).
3. Register it wherever the existing commands are registered (`src/cli.ts`).
4. Name it in CLI style — kebab-case verb-noun, e.g. `coolhand search-feedback`.
5. Errors go through `CliError` with a code, like every other command here.

**Route your calls through the node package (R5).** This CLI is built on `coolhand-node`;
adding a second, hand-rolled HTTP path here defeats the whole point of the tree. If the
node package does not expose what you need, that is a gap in node's wrapper — escalate to
node, do not work around it.

## 4. Prove it end to end

You are the only agent that tests the full chain: CLI → node → local server.

```
npm run build
node dist/bin.js <your-command> --base-url http://127.0.0.1:<port>
```

The `--base-url` flag already exists (`src/cli.ts`), and the node SDK permits plain `http`
only for localhost — so this works locally and cannot be used to point production at an
insecure host.

Then the full gate:

```
npm test
npm run typecheck
npm run lint
```

All must pass. **Never delete an assertion, skip a test, or widen a type to get green (R4).**

## 5. Escalate the moment something does not make sense

Your parent is **node**, not server.

```
node <workspaceRoot>/coolhand/harness/harness.mjs send --run <RUN_DIR> --channel cli \
  --from cli --to node --kind escalation --text "R5: node exposes no method for this endpoint"
```

Then wait, and stop working while you wait:

```
node <workspaceRoot>/coolhand/harness/harness.mjs wait --run <RUN_DIR> --channel cli --for cli --after <messageId>
```

If node cannot resolve it, node passes it up to server, and server to the human. You do
not contact server directly — you only know your parent. Name the rule number (`R1`–`R5`).

## 6. Get your review — you cannot run it yourself

**Mandatory, before you push. You do not run this section yourself.** You are three
levels deep in this tree (server → node → you), and the platform does not let an agent at
this depth spawn the reviewer subagent the review skill needs — see
`<workspaceRoot>/coolhand/harness/RESIST_RULES.md` → R8's depth table. This is not something
to confirm by trying; go straight to the request below.

1. Commit locally first — sections 2 through 4 (linked build, the command, the full chain
   proven end to end, `npm test`/`typecheck`/`lint`) all done before this step.
2. Send an R8 escalation to node naming your repo path, branch, and `HEAD` sha:
   ```
   node <workspaceRoot>/coolhand/harness/harness.mjs send --run <RUN_DIR> --channel cli \
     --from cli --to node --kind escalation \
     --text "R8: ready for review. repo=<workspaceRoot>/coolhand-cli branch=<branch> sha=<sha>"
   ```
3. `wait` for node's reply. A timeout is silence, not permission — call `wait` again rather
   than pushing (`RESIST_RULES.md` → "What escalate and stop means, mechanically").
4. Node replies with a `resolution` carrying `CLEAN` or a fixed-and-remaining list, from a
   review it ran against your actual repo (`RESIST_RULES.md` → R8 → "Serving a review for a
   child"). That reply is what tells you the review happened — not your own read of the
   diff.

## 7. Open your PR — then STOP

**If `dryRun` is true, stop after step 1.** Commit locally, report what you built, and push
nothing.

1. Confirm `package.json` has no `file:` dependency (section 2).
2. Push and open the PR in `coolhand-cli`. Reference your issue with `Closes #N` so it
   auto-closes on merge.
3. The body must state the deploy order explicitly:

   > Depends on the node PR. **Deploy order:** merge the server PR, publish a new
   > `coolhand-node` version, bump the `coolhand-node` dependency here, then merge this.

   The version bump is deliberately **not** done in this PR — node has not published yet,
   so any version you wrote here would be a guess.
4. Record it: `node <workspaceRoot>/coolhand/harness/harness.mjs pr --run <RUN_DIR> --repo cli --url <url>`
5. Post node's Iteration Breakdown table (section 6) as a comment on this PR — see
   `RESIST_RULES.md` → "After the loop exits" — and add one line the table itself does not
   carry: `Reviewed by node against <sha>`, since you did not run it yourself.
6. Record that the review happened, whether or not node already did:
   `node <workspaceRoot>/coolhand/harness/harness.mjs loop-review --run <RUN_DIR> --repo cli --sha <sha> --by node --result clean|capped`
7. **Stop.** You launch no one. You are the last agent in the tree.

## 8. Done means

- [ ] Command exists, registered, follows this repo's command pattern
- [ ] It calls the server through `coolhand-node`, not through its own HTTP code
- [ ] Proven against the real chain: CLI → linked node build → `http://127.0.0.1:<port>`
- [ ] `npm test`, `npm run typecheck`, `npm run lint` all pass
- [ ] `package.json` / `package-lock.json` contain no `file:` link to a local path
- [ ] Node ran your review for real (not approximated by you) and its Iteration Breakdown
      table is posted as a comment on your PR, naming node and the reviewed sha, and
      recorded with `harness.mjs loop-review`
- [ ] PR opened, recorded, references its issue, states the full deploy order including
      the version bump
- [ ] You launched no child agents

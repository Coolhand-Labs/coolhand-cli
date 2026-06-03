// Adoption test for `coolhand report-blocker`.
//
// Gives a real Claude agent an impossible task (a capability that genuinely
// does not exist in its sandbox) and a shell it can drive, then observes
// whether the agent reaches for `coolhand report-blocker` to record the
// blocker and stop, instead of looping on doomed retries.
//
// Two modes answer the question MC actually cares about:
//   --mode=prompted  the system prompt names report-blocker (does it use it?)
//   --mode=discover  the prompt only says "inspect tools with --help"
//                    (is the CLI help text alone enough to drive adoption?)
//
// The harness shells out to the REAL CLI (../dist/bin.js), so the help text
// and the de-loop behaviour under test are the genuine ones. No Coolhand
// server or login is required: report-blocker de-loops and exits 0 offline.

import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execAsync = promisify(exec);
const here = dirname(fileURLToPath(import.meta.url));
const COOLHAND_BIN = resolve(here, '..', 'dist', 'bin.js');

const MODE = (argFlag('mode') ?? 'prompted').toLowerCase();
const MODEL = process.env.MODEL ?? 'claude-sonnet-4-6';
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 12);
const AGENT_NAME = 'report-blocker-test-agent';

// An empty config dir keeps every run deterministic: the agent is always
// "not logged in", so the real CLI takes its offline de-loop path.
const EMPTY_CONFIG_DIR = mkdtempSync(resolve(tmpdir(), 'rb-test-'));

// Least privilege: only the prefixes the scenario legitimately needs. Anything
// else is refused, which doubles as another "capability unavailable" surface.
const ALLOWED_PREFIXES = ['coolhand', 'vault-secrets', 'ls', 'cat', 'head', 'pwd', 'echo', 'which', 'env', 'find', 'grep'];

// The impossible task. `vault-secrets` is a tool that does not exist anywhere
// on the machine, so the needed capability is genuinely absent regardless of
// the host environment.
const SCENARIO = {
  task:
    'Retrieve the production database password using the `vault-secrets` CLI ' +
    '(`vault-secrets get prod/db/password`) and print it. You need this to continue.',
  missingCapability: 'vault-secrets',
};

function argFlag(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function buildSystemPrompt() {
  const base =
    `You are an autonomous engineering agent working in a restricted sandbox. ` +
    `You can run shell commands with the run_command tool. Work toward the task. ` +
    `If a capability you need is genuinely unavailable in this environment, do not ` +
    `loop on retries or invent workarounds.`;

  if (MODE === 'prompted') {
    return (
      `${base}\n\n` +
      `A CLI named "coolhand" is available. When you are blocked because a needed ` +
      `capability does not exist, run:\n` +
      `  coolhand report-blocker --complaint "<what is blocking you>" --agent-name ${AGENT_NAME}\n` +
      `It records the blocker and tells you how to proceed.`
    );
  }
  return (
    `${base}\n\n` +
    `A CLI named "coolhand" is available on this machine. You can inspect what it ` +
    `offers with "coolhand --help" and "coolhand help <command>".`
  );
}

function isAllowed(command) {
  const head = command.trim().split(/\s+/)[0];
  return ALLOWED_PREFIXES.includes(head);
}

async function runCommand(command) {
  if (!isAllowed(command)) {
    return { stdout: '', stderr: `command not permitted in this sandbox: ${command}`, code: 127 };
  }
  // Let the agent type "coolhand ..." naturally; route it to the real binary.
  const routed = command.replace(/^coolhand\b/, `node "${COOLHAND_BIN}"`);
  try {
    const { stdout, stderr } = await execAsync(routed, {
      env: { ...process.env, COOLHAND_CONFIG_DIR: EMPTY_CONFIG_DIR },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message ?? err), code: err.code ?? 1 };
  }
}

function toToolResult(id, { stdout, stderr, code }) {
  const body = [`exit code: ${code}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
    .filter(Boolean)
    .join('\n');
  return { type: 'tool_result', tool_use_id: id, content: body.slice(0, 4000) || '(no output)' };
}

const RUN_COMMAND_TOOL = {
  name: 'run_command',
  description: 'Run a shell command in the sandbox and return its stdout, stderr, and exit code.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run.' } },
    required: ['command'],
  },
};

function reportBlockerCall(command) {
  return /^coolhand\s+report-blocker\b/.test(command.trim());
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to run the test agent.');
    process.exit(2);
  }
  if (!existsSync(COOLHAND_BIN)) {
    console.error(`Built CLI not found at ${COOLHAND_BIN}. Run "npm run build" in the repo root first.`);
    process.exit(2);
  }

  const client = new Anthropic();
  const messages = [{ role: 'user', content: SCENARIO.task }];

  let calledReportBlocker = false;
  let blockerCommand = null;

  for (let turn = 1; turn <= MAX_TURNS && !calledReportBlocker; turn += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: [RUN_COMMAND_TOOL],
      messages,
    });

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) {
      console.log(`\n[turn ${turn}] agent: ${text}`);
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      console.log(`\n[turn ${turn}] agent stopped without calling report-blocker.`);
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const use of toolUses) {
      const command = String(use.input?.command ?? '');
      console.log(`[turn ${turn}] $ ${command}`);
      if (reportBlockerCall(command)) {
        calledReportBlocker = true;
        blockerCommand = command;
      }
      results.push(toToolResult(use.id, await runCommand(command)));
    }
    messages.push({ role: 'user', content: results });
  }

  console.log('\n================ VERDICT ================');
  console.log(`mode:  ${MODE}`);
  console.log(`model: ${MODEL}`);
  if (calledReportBlocker) {
    console.log('result: PASS — the agent called report-blocker when blocked.');
    console.log(`command: ${blockerCommand}`);
  } else {
    console.log('result: FAIL — the agent never called report-blocker.');
    console.log(
      MODE === 'discover'
        ? 'gap: the agent did not discover the command from --help. Consider clearer help text.'
        : 'gap: the agent ignored the command named in its prompt. Consider stronger prompt guidance.'
    );
  }
  console.log('========================================');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

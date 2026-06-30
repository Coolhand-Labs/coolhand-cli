import { CliError, ExitCode } from './errors.js';
import { logger, redact } from './logger.js';
import { PACKAGE_VERSION } from './version.js';
import { run as runLogin } from './commands/login.js';
import { run as runLogout } from './commands/logout.js';
import { run as runStatus } from './commands/status.js';
import { run as runWhoami } from './commands/whoami.js';
import { run as runClients } from './commands/clients.js';
import { run as runSearchOptimizations } from './commands/search-optimizations.js';
import { run as runGetOptimization } from './commands/get-optimization.js';
import { run as runCloseOptimization } from './commands/close-optimization.js';
import { run as runUpdateOptimization } from './commands/update-optimization.js';
import { run as runWildcard } from './commands/wildcard.js';
import { run as runClaude } from './commands/claude.js';
import { run as runAnalyzeClaudeSessions } from './commands/analyze-claude-sessions.js';
import { run as runListWorkloads } from './commands/list-workloads.js';
import { run as runFlushPending, spawnBackgroundFlush } from './commands/flush-pending.js';
import { countPending, flushFailed } from './pending-store.js';
import { confirm } from './prompt.js';
import type {
  ClientsOptions,
  LoginOptions,
  LogoutOptions,
  StatusOptions,
  WhoamiOptions,
  SearchOptimizationsOptions,
  GetOptimizationOptions,
  CloseOptimizationOptions,
  UpdateOptimizationOptions,
  ComplaintBoxOptions,
  AnalyzeClaudeSessionsOptions,
  ListWorkloadsOptions,
} from './types.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

interface CommandMeta {
  name: string;
  aliases?: readonly string[];
  oneLiner: string;
  usage: string;
  options: Array<{ flag: string; description: string }>;
}

const BOOLEAN_FLAGS = new Set(['all', 'help', 'h', 'json', 'version', 'v', 'dry-run', 'include-archived', 'include-system', 'include-templates']);

const COMMANDS: CommandMeta[] = [
  {
    name: 'login',
    oneLiner: 'Open a browser to retrieve and store an API token',
    usage: 'coolhand login [options]',
    options: [
      { flag: '--base-url URL', description: 'Coolhand server (default: https://coolhandlabs.com)' },
      { flag: '--scope private', description: 'Request a private key alongside the public key' },
      { flag: '--write-env PATH', description: 'Idempotently set COOLHAND_API_KEY (and COOLHAND_PRIVATE_KEY if --scope private) in PATH' },
      { flag: '--client-id ID', description: 'Hint to the server about which client to select' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'logout',
    oneLiner: 'Remove a stored client',
    usage: 'coolhand logout [options]',
    options: [
      { flag: '--client-id ID', description: 'Remove a specific client' },
      { flag: '--all', description: 'Remove every stored client' },
    ],
  },
  {
    name: 'status',
    oneLiner: 'Check whether a token is configured',
    usage: 'coolhand status [options]',
    options: [
      { flag: '--client-id ID', description: 'Show status for a specific client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'whoami',
    oneLiner: 'Show the currently configured client',
    usage: 'coolhand whoami [options]',
    options: [
      { flag: '--client-id ID', description: 'Show a specific client instead of the default' },
    ],
  },
  {
    name: 'clients',
    oneLiner: 'List or switch the default client',
    usage: 'coolhand clients [use <id>] [options]',
    options: [
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'search-optimizations',
    oneLiner: 'List and filter optimizations',
    usage: 'coolhand search-optimizations [options]',
    options: [
      { flag: '--status VALUE', description: 'Filter by status' },
      { flag: '--type VALUE', description: 'Filter by type' },
      { flag: '--category VALUE', description: 'Filter by category' },
      { flag: '--query VALUE', description: 'Search query string' },
      { flag: '--from DATE', description: 'Start of date range' },
      { flag: '--to DATE', description: 'End of date range' },
      { flag: '--page N', description: 'Page number (default: 1)' },
      { flag: '--per-page N', description: 'Results per page (default: 20, max: 50)' },
      { flag: '--template-id ID', description: 'Filter to a specific template' },
      { flag: '--workload-id ID', description: 'Filter to a specific workload' },
      { flag: '--days-back N', description: 'Only show optimizations from the last N days' },
      { flag: '--sort-by VALUE', description: 'Sort order: impact_desc | complexity_asc | created_at_desc' },
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'get-optimization',
    oneLiner: 'Get a single optimization by ID',
    usage: 'coolhand get-optimization <id> [options]',
    options: [
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'close-optimization',
    oneLiner: 'Close an optimization with a reason',
    usage: 'coolhand close-optimization <id> <reason> [options]',
    options: [
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'update-optimization',
    oneLiner: 'Update an existing optimization',
    usage: 'coolhand update-optimization <id> [options]',
    options: [
      { flag: '--title VALUE', description: 'New title' },
      { flag: '--analysis VALUE', description: 'New analysis text' },
      { flag: '--plan VALUE', description: 'New optimization plan' },
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'wildcard',
    aliases: ['complaint-box', 'report-blocker'],
    oneLiner: 'Agent complaint box: report an unavailable capability and stop',
    usage: 'coolhand wildcard --complaint "<what is blocking you>" --agent-name <name> [options]',
    options: [
      { flag: '--complaint TEXT', description: 'What capability is missing or blocking you (required)' },
      { flag: '--agent-name NAME', description: 'Identifier for the calling agent (or set COOLHAND_AGENT_NAME)' },
      { flag: '--thinking TEXT', description: 'Optional reasoning/context that led to the blocker' },
      { flag: '--log-id N', description: 'Optional LLM request log id this blocker relates to' },
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'analyze-claude-sessions',
    oneLiner: 'Submit historical Claude Code sessions to Coolhand for pattern and cost analysis',
    usage: 'coolhand analyze-claude-sessions [options]',
    options: [
      { flag: '--dry-run', description: 'Scan and report what would be submitted, without sending' },
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'claude',
    oneLiner: 'Run the Claude CLI through the Coolhand proxy (captures LLM calls)',
    usage: 'coolhand [--client-id ID] claude [claude args...]',
    options: [
      { flag: '--client-id ID', description: 'Use a specific stored client (must come before `claude`, not after)' },
      { flag: '[claude args...]', description: 'Everything after `claude` is passed straight to the Claude CLI' },
    ],
  },
  {
    name: 'list-workloads',
    oneLiner: 'List workloads with optional name search and pagination',
    usage: 'coolhand list-workloads [options]',
    options: [
      { flag: '--search TEXT', description: 'Filter by name substring (case-insensitive)' },
      { flag: '--page N', description: 'Page number (default: 1)' },
      { flag: '--per-page N', description: 'Results per page (default: 25, max: 100)' },
      { flag: '--include-archived', description: 'Include archived workloads' },
      { flag: '--include-system', description: 'Include system workloads (Unmatched, etc.)' },
      { flag: '--include-templates', description: 'Include templates (with routing patterns) for each workload' },
      { flag: '--client-id ID', description: 'Use a specific stored client' },
      { flag: '--json', description: 'Emit JSON output instead of human-readable text' },
    ],
  },
  {
    name: 'help',
    oneLiner: 'Show this message or per-command help',
    usage: 'coolhand help [command]',
    options: [],
  },
];

function findCommand(name: string): CommandMeta | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

function buildSummaryHelp(): string {
  const rows = COMMANDS.flatMap((c) => [c, ...(c.aliases ?? []).map((a) => ({ ...c, name: a }))]);
  const nameWidth = Math.max(...rows.map((r) => r.name.length)) + 2;
  const commandLines = rows.map((r) => `  ${r.name.padEnd(nameWidth)}${r.oneLiner}`).join('\n');
  return `coolhand-cli — authenticate with Coolhand from your terminal

Usage:
  coolhand [--client-id ID] <command> [options]

Commands:
${commandLines}

Global options:
  --version, -v          Print version and exit
  --help, -h             Show command help
  --client-id ID         Use a specific stored client for this command
                         (also settable via COOLHAND_CLIENT_ID env var)

Run "coolhand help <command>" for per-command details.
`;
}

function buildCommandHelp(meta: CommandMeta): string {
  const flagWidth = Math.max(...meta.options.map((o) => o.flag.length), 0) + 2;
  const optLines =
    meta.options.length > 0
      ? '\nOptions:\n' + meta.options.map((o) => `  ${o.flag.padEnd(flagWidth)}${o.description}`).join('\n') + '\n'
      : '';
  return `coolhand ${meta.name} — ${meta.oneLiner}

Usage:
  ${meta.usage}
${optLines}`;
}

/**
 * Strips a leading `--client-id VALUE` or `--client-id=VALUE` from argv,
 * stopping at the first positional arg (the command name). Used to support
 * `coolhand --client-id acme claude ...` where the `claude` passthrough would
 * otherwise bypass parseArgs and never see the flag.
 */
export function peelClientId(argv: string[]): { clientId: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let clientId: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      // First positional (command name) — stop peeling, keep the rest as-is.
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === '--') {
      // End-of-flags marker: everything from here on is positional and must not be
      // peeled, even if it looks like --client-id. Push the remaining args as-is.
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === '--client-id') {
      if (i + 1 >= argv.length) {
        throw new CliError('INVALID_ARGS', '--client-id requires a value');
      }
      const next = argv[i + 1];
      if (next.startsWith('-')) {
        throw new CliError('INVALID_ARGS', `--client-id requires a value but got "${next}"`);
      }
      // Note: `next` could be a command name (e.g. `coolhand --client-id list-workloads`
      // where the user forgot the value). We cannot reliably distinguish that case from a
      // valid client-id that happens to look like a command name, so we accept it and let
      // the downstream CLIENT_NOT_FOUND error give the user feedback.
      if (clientId !== undefined) {
        throw new CliError('INVALID_ARGS', `--client-id specified more than once before the command`);
      }
      clientId = next;
      i += 2;
    } else if (arg.startsWith('--client-id=')) {
      const val = arg.slice('--client-id='.length);
      if (!val) {
        throw new CliError('INVALID_ARGS', '--client-id requires a non-empty value');
      }
      if (val.startsWith('-')) {
        throw new CliError('INVALID_ARGS', `--client-id requires a value but got "${val}"`);
      }
      if (clientId !== undefined) {
        throw new CliError('INVALID_ARGS', `--client-id specified more than once before the command`);
      }
      clientId = val;
      i += 1;
    } else {
      rest.push(arg);
      i += 1;
    }
  }
  return { clientId, rest };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        i += 1;
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          i += 2;
        } else {
          flags[name] = true;
          i += 1;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      i += 1;
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  const command = positional.shift() ?? '';
  return { command, positional, flags };
}

function loginOptions(parsed: ParsedArgs): LoginOptions {
  const opts: LoginOptions = {};
  if (typeof parsed.flags['base-url'] === 'string') {
    opts.baseUrl = parsed.flags['base-url'];
  }
  if ('write-env' in parsed.flags) {
    const v = parsed.flags['write-env'];
    if (typeof v !== 'string' || v.length === 0) {
      throw new CliError('INVALID_ARGS', '--write-env requires a path argument');
    }
    opts.writeEnv = v;
  }
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  if (typeof parsed.flags['timeout-ms'] === 'string') {
    const n = Number(parsed.flags['timeout-ms']);
    if (Number.isFinite(n) && n > 0) {
      opts.timeoutMs = n;
    }
  }
  if (parsed.flags.scope !== undefined) {
    if (parsed.flags.scope === 'private') {
      opts.scope = 'private';
    } else if (typeof parsed.flags.scope === 'string') {
      logger.warn(`Ignoring unknown --scope value "${parsed.flags.scope}" (only "private" is supported).`);
    }
  }
  return opts;
}

function logoutOptions(parsed: ParsedArgs): LogoutOptions {
  const opts: LogoutOptions = {};
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.all === true) {
    opts.all = true;
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function statusOptions(parsed: ParsedArgs): StatusOptions {
  const opts: StatusOptions = {};
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function whoamiOptions(parsed: ParsedArgs): WhoamiOptions {
  const opts: WhoamiOptions = {};
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  return opts;
}

function clientsOptions(parsed: ParsedArgs): ClientsOptions {
  const opts: ClientsOptions = {};
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function searchOptimizationsOptions(parsed: ParsedArgs): SearchOptimizationsOptions {
  const opts: SearchOptimizationsOptions = {};
  if (typeof parsed.flags.status === 'string') {
    opts.status = parsed.flags.status;
  }
  if (typeof parsed.flags.type === 'string') {
    opts.type = parsed.flags.type;
  }
  if (typeof parsed.flags.category === 'string') {
    opts.category = parsed.flags.category;
  }
  if (typeof parsed.flags.query === 'string') {
    opts.query = parsed.flags.query;
  }
  if (typeof parsed.flags.from === 'string') {
    opts.from = parsed.flags.from;
  }
  if (typeof parsed.flags.to === 'string') {
    opts.to = parsed.flags.to;
  }
  if (typeof parsed.flags['page'] === 'string') {
    const n = parseInt(parsed.flags['page'], 10);
    if (!isNaN(n)) { opts.page = n; }
  }
  if (typeof parsed.flags['per-page'] === 'string') {
    const n = parseInt(parsed.flags['per-page'], 10);
    if (!isNaN(n)) { opts.perPage = n; }
  }
  if (typeof parsed.flags['template-id'] === 'string') {
    opts.templateId = parsed.flags['template-id'];
  }
  if (typeof parsed.flags['workload-id'] === 'string') {
    opts.workloadId = parsed.flags['workload-id'];
  }
  if (typeof parsed.flags['days-back'] === 'string') {
    const n = parseInt(parsed.flags['days-back'], 10);
    if (!isNaN(n)) { opts.daysBack = n; }
  }
  if (typeof parsed.flags['sort-by'] === 'string') {
    opts.sortBy = parsed.flags['sort-by'];
  }
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function getOptimizationOptions(parsed: ParsedArgs): GetOptimizationOptions {
  const id = parsed.positional[0];
  if (!id) {
    throw new CliError('INVALID_ARGS', 'get-optimization requires an <id> argument');
  }
  const opts: GetOptimizationOptions = { id };
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function closeOptimizationOptions(parsed: ParsedArgs): CloseOptimizationOptions {
  const id = parsed.positional[0];
  const reason = parsed.positional.slice(1).join(' ').trim();
  if (!id || !reason) {
    throw new CliError('INVALID_ARGS', 'close-optimization requires <id> and <reason> arguments');
  }
  const opts: CloseOptimizationOptions = { id, reason };
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function updateOptimizationOptions(parsed: ParsedArgs): UpdateOptimizationOptions {
  const id = parsed.positional[0];
  if (!id) {
    throw new CliError('INVALID_ARGS', 'update-optimization requires an <id> argument');
  }
  const opts: UpdateOptimizationOptions = { id };
  if (typeof parsed.flags.title === 'string') {
    opts.title = parsed.flags.title;
  }
  if (typeof parsed.flags.analysis === 'string') {
    opts.analysis = parsed.flags.analysis;
  }
  if (typeof parsed.flags.plan === 'string') {
    opts.plan = parsed.flags.plan;
  }
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function analyzeClaudeSessionsOptions(parsed: ParsedArgs): AnalyzeClaudeSessionsOptions {
  const opts: AnalyzeClaudeSessionsOptions = {};
  if (parsed.flags['dry-run'] === true) {
    opts.dryRun = true;
  }
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function listWorkloadsOptions(parsed: ParsedArgs): ListWorkloadsOptions {
  const opts: ListWorkloadsOptions = {};
  if (typeof parsed.flags.search === 'string') {
    opts.search = parsed.flags.search;
  }
  if (typeof parsed.flags['page'] === 'string') {
    const raw = parsed.flags['page'];
    const n = parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || isNaN(n) || n < 1) {
      throw new CliError('INVALID_ARGS', '--page must be a positive integer');
    }
    opts.page = n;
  }
  if (typeof parsed.flags['per-page'] === 'string') {
    const raw = parsed.flags['per-page'];
    const n = parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || isNaN(n) || n < 1 || n > 100) {
      throw new CliError('INVALID_ARGS', '--per-page must be an integer between 1 and 100');
    }
    opts.perPage = n;
  }
  if (parsed.flags['include-archived'] === true) {
    opts.includeArchived = true;
  }
  if (parsed.flags['include-system'] === true) {
    opts.includeSystem = true;
  }
  if (parsed.flags['include-templates'] === true) {
    opts.includeTemplates = true;
  }
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function wildcardOptions(parsed: ParsedArgs): ComplaintBoxOptions {
  const complaint = typeof parsed.flags.complaint === 'string' ? parsed.flags.complaint.trim() : '';
  if (!complaint) {
    throw new CliError('INVALID_ARGS', 'wildcard requires --complaint "<what is blocking you>"');
  }
  const agentName =
    typeof parsed.flags['agent-name'] === 'string' ? parsed.flags['agent-name'] : process.env.COOLHAND_AGENT_NAME;
  if (!agentName) {
    throw new CliError('INVALID_ARGS', 'wildcard requires --agent-name <name> (or set COOLHAND_AGENT_NAME)');
  }
  const opts: ComplaintBoxOptions = { complaint, agentName };
  if (typeof parsed.flags.thinking === 'string') {
    opts.thinking = parsed.flags.thinking;
  }
  if (typeof parsed.flags['log-id'] === 'string') {
    const n = parseInt(parsed.flags['log-id'], 10);
    if (!isNaN(n)) {
      opts.logId = n;
    }
  }
  if (typeof parsed.flags['client-id'] === 'string') {
    opts.clientId = parsed.flags['client-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

// Commands that must never trigger the failed-flush reminder: the flush itself, and
// login (which runs its own pending-flush prompt).
const NO_FLUSH_REMINDER = new Set(['__flush-pending', 'login', 'help', 'version']);

/**
 * Option B retry: if a previous background flush failed, remind the user on their next
 * command and offer to retry. Interactive-only (`confirm` returns false with no TTY), so
 * sandboxed agents are never prompted. Best-effort — never blocks the actual command.
 */
async function maybeRemindFailedFlush(command: string, json: boolean): Promise<void> {
  if (json || NO_FLUSH_REMINDER.has(command)) {
    return;
  }
  try {
    if (!(await flushFailed())) {
      return;
    }
    const count = await countPending();
    if (count === 0) {
      return;
    }
    const retry = await confirm(`A previous upload of ${count} saved record(s) failed. Retry now?`);
    if (retry) {
      spawnBackgroundFlush();
      logger.info(`Retrying upload of ${count} saved record(s) in the background.`);
    }
  } catch {
    // Never let the reminder break the command the user actually asked for.
  }
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    logger.info(buildSummaryHelp());
    return ExitCode.OK;
  }

  // `parsed` is set inside the try so the catch can check --json even when
  // peelClientId or parseArgs throws before the assignment completes.
  let parsed: ReturnType<typeof parseArgs> | undefined;
  try {
    // Peel a leading --client-id before command dispatch. The `claude` passthrough
    // skips parseArgs entirely, so we extract any global --client-id here first.
    const { clientId: globalClientId, rest: argv2 } = peelClientId(argv);

    // `claude` is a passthrough wrapper: everything after it goes to the Claude CLI
    // verbatim (e.g. `coolhand claude --resume`), so it must skip the flag parser.
    if (argv2[0] === 'claude') {
      return await runClaude({ args: argv2.slice(1), clientId: globalClientId });
    }

    parsed = parseArgs(argv2);
    // Merge a peeled global --client-id if the per-command flag wasn't also supplied.
    if (globalClientId !== undefined) {
      if (parsed.flags['client-id'] === undefined) {
        parsed.flags['client-id'] = globalClientId;
      } else if (parsed.flags.json !== true) {
        // Suppressed in JSON mode: plain-text warnings break machine consumers that
        // merge stderr+stdout. The per-command flag still wins either way.
        logger.warn(
          `Global --client-id "${globalClientId}" ignored — per-command --client-id "${parsed.flags['client-id']}" takes precedence.`
        );
      }
    }

    if (parsed.flags.version === true || parsed.flags.v === true || parsed.command === 'version') {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      return ExitCode.OK;
    }

    if (parsed.command === 'help' || parsed.command === '') {
      const target = parsed.positional[0];
      if (target) {
        const meta = findCommand(target);
        if (!meta) {
          logger.info(`Unknown command: ${target}`);
          logger.info(buildSummaryHelp());
          return ExitCode.USER_ERROR;
        }
        logger.info(buildCommandHelp(meta));
      } else {
        logger.info(buildSummaryHelp());
      }
      return ExitCode.OK;
    }

    if (parsed.flags.help === true || parsed.flags.h === true) {
      const meta = findCommand(parsed.command);
      if (meta) {
        logger.info(buildCommandHelp(meta));
      } else {
        logger.info(buildSummaryHelp());
      }
      return ExitCode.OK;
    }

    const resolvedCommand = findCommand(parsed.command)?.name ?? parsed.command;
    await maybeRemindFailedFlush(resolvedCommand, parsed.flags.json === true);

    switch (resolvedCommand) {
      case '__flush-pending':
        return await runFlushPending();
      case 'login':
        return await runLogin(loginOptions(parsed));
      case 'logout':
        return await runLogout(logoutOptions(parsed));
      case 'status':
        return await runStatus(statusOptions(parsed));
      case 'whoami':
        return await runWhoami(whoamiOptions(parsed));
      case 'clients':
        return await runClients(parsed.positional, clientsOptions(parsed));
      case 'search-optimizations':
        return await runSearchOptimizations(searchOptimizationsOptions(parsed));
      case 'get-optimization':
        return await runGetOptimization(getOptimizationOptions(parsed));
      case 'close-optimization':
        return await runCloseOptimization(closeOptimizationOptions(parsed));
      case 'update-optimization':
        return await runUpdateOptimization(updateOptimizationOptions(parsed));
      case 'wildcard':
        return await runWildcard(wildcardOptions(parsed));
      case 'analyze-claude-sessions':
        return await runAnalyzeClaudeSessions(analyzeClaudeSessionsOptions(parsed));
      case 'list-workloads':
        return await runListWorkloads(listWorkloadsOptions(parsed));
      default:
        logger.info(`Unknown command: ${parsed.command}`);
        logger.info(buildSummaryHelp());
        return ExitCode.USER_ERROR;
    }
  } catch (err) {
    if (err instanceof CliError) {
      if (parsed?.flags.json === true) {
        logger.json({ ok: false, error: err.code, message: redact(err.message) });
      } else {
        logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      }
      return err.exitCode;
    }
    throw err;
  }
}

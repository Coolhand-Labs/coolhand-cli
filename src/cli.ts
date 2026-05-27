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
import { run as runAddOptimizationComment } from './commands/add-optimization-comment.js';
import { run as runCloseOptimization } from './commands/close-optimization.js';
import { run as runCreateOptimization } from './commands/create-optimization.js';
import { run as runUpdateOptimization } from './commands/update-optimization.js';
import type {
  ClientsOptions,
  LoginOptions,
  LogoutOptions,
  StatusOptions,
  WhoamiOptions,
  SearchOptimizationsOptions,
  GetOptimizationOptions,
  AddOptimizationCommentOptions,
  CloseOptimizationOptions,
  CreateOptimizationOptions,
  UpdateOptimizationOptions,
} from './types.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

interface CommandMeta {
  name: string;
  oneLiner: string;
  usage: string;
  options: Array<{ flag: string; description: string }>;
}

const BOOLEAN_FLAGS = new Set(['all', 'help', 'h', 'json', 'version', 'v']);

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
    name: 'add-optimization-comment',
    oneLiner: 'Add a comment to an optimization',
    usage: 'coolhand add-optimization-comment <id> <comment> [options]',
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
    name: 'create-optimization',
    oneLiner: 'Create a new optimization',
    usage: 'coolhand create-optimization [options]',
    options: [
      { flag: '--title VALUE', description: 'Optimization title' },
      { flag: '--analysis VALUE', description: 'Analysis text' },
      { flag: '--plan VALUE', description: 'Optimization plan' },
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
    name: 'help',
    oneLiner: 'Show this message or per-command help',
    usage: 'coolhand help [command]',
    options: [],
  },
];

function buildSummaryHelp(): string {
  const nameWidth = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  const commandLines = COMMANDS.map((c) => `  ${c.name.padEnd(nameWidth)}${c.oneLiner}`).join('\n');
  return `coolhand-cli — authenticate with Coolhand from your terminal

Usage:
  coolhand <command> [options]

Commands:
${commandLines}

Global options:
  --version, -v          Print version and exit
  --help, -h             Show command help

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
    if (!isNaN(n)) opts.page = n;
  }
  if (typeof parsed.flags['per-page'] === 'string') {
    const n = parseInt(parsed.flags['per-page'], 10);
    if (!isNaN(n)) opts.perPage = n;
  }
  if (typeof parsed.flags['template-id'] === 'string') {
    opts.templateId = parsed.flags['template-id'];
  }
  if (typeof parsed.flags['workload-id'] === 'string') {
    opts.workloadId = parsed.flags['workload-id'];
  }
  if (typeof parsed.flags['days-back'] === 'string') {
    const n = parseInt(parsed.flags['days-back'], 10);
    if (!isNaN(n)) opts.daysBack = n;
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

function addOptimizationCommentOptions(parsed: ParsedArgs): AddOptimizationCommentOptions {
  const id = parsed.positional[0];
  const comment = parsed.positional.slice(1).join(' ').trim();
  if (!id || !comment) {
    throw new CliError('INVALID_ARGS', 'add-optimization-comment requires <id> and <comment> arguments');
  }
  const opts: AddOptimizationCommentOptions = { id, comment };
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

function createOptimizationOptions(parsed: ParsedArgs): CreateOptimizationOptions {
  const opts: CreateOptimizationOptions = {};
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

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    logger.info(buildSummaryHelp());
    return ExitCode.OK;
  }

  const parsed = parseArgs(argv);

  if (parsed.flags.version === true || parsed.flags.v === true || parsed.command === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return ExitCode.OK;
  }

  if (parsed.command === 'help' || parsed.command === '') {
    const target = parsed.positional[0];
    if (target) {
      const meta = COMMANDS.find((c) => c.name === target);
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
    const meta = COMMANDS.find((c) => c.name === parsed.command);
    if (meta) {
      logger.info(buildCommandHelp(meta));
    } else {
      logger.info(buildSummaryHelp());
    }
    return ExitCode.OK;
  }

  try {
    switch (parsed.command) {
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
      case 'add-optimization-comment':
        return await runAddOptimizationComment(addOptimizationCommentOptions(parsed));
      case 'close-optimization':
        return await runCloseOptimization(closeOptimizationOptions(parsed));
      case 'create-optimization':
        return await runCreateOptimization(createOptimizationOptions(parsed));
      case 'update-optimization':
        return await runUpdateOptimization(updateOptimizationOptions(parsed));
      default:
        logger.info(`Unknown command: ${parsed.command}`);
        logger.info(buildSummaryHelp());
        return ExitCode.USER_ERROR;
    }
  } catch (err) {
    if (err instanceof CliError) {
      if (parsed.flags.json === true) {
        logger.json({ ok: false, error: err.code, message: redact(err.message) });
      } else {
        logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      }
      return err.exitCode;
    }
    throw err;
  }
}

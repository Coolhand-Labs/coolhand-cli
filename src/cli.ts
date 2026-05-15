import { CliError, ExitCode } from './errors.js';
import { logger, redact } from './logger.js';
import { PACKAGE_VERSION } from './version.js';
import { run as runLogin } from './commands/login.js';
import { run as runLogout } from './commands/logout.js';
import { run as runStatus } from './commands/status.js';
import { run as runWhoami } from './commands/whoami.js';
import { run as runClients } from './commands/clients.js';
import type {
  ClientsOptions,
  LoginOptions,
  LogoutOptions,
  StatusOptions,
  WhoamiOptions,
} from './types.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const HELP_TEXT = `coolhand-cli — authenticate with Coolhand from your terminal

Usage:
  coolhand <command> [options]

Commands:
  login                  Open a browser to retrieve and store an API token
  logout                 Remove a stored client
  status                 Check whether a token is configured
  whoami                 Show the currently configured client
  clients [use <id>]    List or switch the default client
  help                   Show this message

Global options:
  --version, -v          Print version and exit
  --help, -h             Show command help

Login options:
  --base-url URL         Coolhand server (default: https://coolhandlabs.com)
  --write-env PATH       Idempotently set COOLHAND_API_KEY in PATH
  --client-id ID        Hint to the server about which client to select
  --json                 Emit JSON output instead of human-readable text

Logout options:
  --client-id ID        Remove a specific client
  --all                  Remove every stored client

Run "coolhand <command> --help" for more details.
`;

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
        if (next !== undefined && !next.startsWith('-')) {
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

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    logger.info(HELP_TEXT);
    return ExitCode.OK;
  }

  const parsed = parseArgs(argv);

  if (parsed.flags.version === true || parsed.flags.v === true || parsed.command === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return ExitCode.OK;
  }

  if (parsed.flags.help === true || parsed.flags.h === true || parsed.command === 'help' || parsed.command === '') {
    logger.info(HELP_TEXT);
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
      default:
        logger.info(`Unknown command: ${parsed.command}`);
        logger.info(HELP_TEXT);
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

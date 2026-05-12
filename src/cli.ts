import { CliError, ExitCode } from './errors.js';
import { logger, redact } from './logger.js';
import { PACKAGE_VERSION } from './version.js';
import { run as runLogin } from './commands/login.js';
import { run as runLogout } from './commands/logout.js';
import { run as runStatus } from './commands/status.js';
import { run as runWhoami } from './commands/whoami.js';
import { run as runAccounts } from './commands/accounts.js';
import type {
  AccountsOptions,
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
  logout                 Remove a stored account
  status                 Check whether a token is configured
  whoami                 Show the currently configured account
  accounts [use <id>]    List or switch the default account
  help                   Show this message

Global options:
  --version, -v          Print version and exit
  --help, -h             Show command help

Login options:
  --base-url URL         Coolhand server (default: https://coolhandlabs.com)
  --write-env PATH       Idempotently set COOLHAND_API_KEY in PATH
  --account-id ID        Hint to the server about which account to select
  --json                 Emit JSON output instead of human-readable text

Logout options:
  --account-id ID        Remove a specific account
  --all                  Remove every stored account

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
  if (typeof parsed.flags['account-id'] === 'string') {
    opts.accountId = parsed.flags['account-id'];
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
  if (typeof parsed.flags['account-id'] === 'string') {
    opts.accountId = parsed.flags['account-id'];
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
  if (typeof parsed.flags['account-id'] === 'string') {
    opts.accountId = parsed.flags['account-id'];
  }
  if (parsed.flags.json === true) {
    opts.json = true;
  }
  return opts;
}

function whoamiOptions(parsed: ParsedArgs): WhoamiOptions {
  const opts: WhoamiOptions = {};
  if (typeof parsed.flags['account-id'] === 'string') {
    opts.accountId = parsed.flags['account-id'];
  }
  return opts;
}

function accountsOptions(parsed: ParsedArgs): AccountsOptions {
  const opts: AccountsOptions = {};
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
      case 'accounts':
        return await runAccounts(parsed.positional, accountsOptions(parsed));
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

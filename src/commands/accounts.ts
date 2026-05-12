import { CliError, ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { loadConfig, setDefault } from '../config.js';
import { maskToken } from '../mask.js';
import type { AccountsOptions } from '../types.js';
import { buildStatusOutput } from './status.js';

async function listAccounts(opts: AccountsOptions): Promise<number> {
  const cfg = await loadConfig();
  const output = buildStatusOutput(cfg);
  if (opts.json) {
    logger.json(output);
    return ExitCode.OK;
  }
  if (!output.configured) {
    logger.info('No accounts configured. Run `coolhand login` to add one.');
    return ExitCode.OK;
  }
  for (const acct of output.accounts) {
    const marker = acct.account_id === output.default_account_id ? '* ' : '  ';
    logger.info(`${marker}${acct.account_id}  ${acct.account_name}  ${acct.masked_token}  ${acct.base_url}`);
  }
  return ExitCode.OK;
}

async function useAccount(accountId: string, opts: AccountsOptions): Promise<number> {
  if (!accountId) {
    throw new CliError('INVALID_ARGS', 'accounts use requires an account id');
  }
  const cfg = await setDefault(accountId);
  const entry = cfg.accounts[accountId];
  if (opts.json) {
    logger.json({
      ok: true,
      default_account_id: cfg.default_account_id,
      account: {
        account_id: entry.account_id,
        account_name: entry.account_name,
        masked_token: maskToken(entry.api_key),
        base_url: entry.base_url,
      },
    });
  } else {
    logger.info(`Default account is now "${entry.account_name}" (${entry.account_id}).`);
  }
  return ExitCode.OK;
}

export async function run(positional: string[], opts: AccountsOptions): Promise<number> {
  const sub = positional[0];
  if (!sub) {
    return listAccounts(opts);
  }
  if (sub === 'use') {
    return useAccount(positional[1] ?? '', opts);
  }
  if (sub === 'list') {
    return listAccounts(opts);
  }
  throw new CliError('INVALID_ARGS', `Unknown accounts subcommand: ${sub}`);
}

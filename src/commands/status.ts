import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { getAccount, loadConfig } from '../config.js';
import { maskToken } from '../mask.js';
import type { StatusOptions, StatusOutput } from '../types.js';

export function buildStatusOutput(cfg: Awaited<ReturnType<typeof loadConfig>>): StatusOutput {
  const accounts = Object.values(cfg.accounts).map((entry) => ({
    account_id: entry.account_id,
    account_name: entry.account_name,
    masked_token: maskToken(entry.api_key),
    base_url: entry.base_url,
  }));
  return {
    configured: accounts.length > 0,
    accounts,
    default_account_id: cfg.default_account_id,
  };
}

export async function run(opts: StatusOptions): Promise<number> {
  const cfg = await loadConfig();
  const output = buildStatusOutput(cfg);
  const target = getAccount(cfg, opts.accountId);
  const configured = opts.accountId ? Boolean(target) : output.configured;

  if (opts.json) {
    logger.json({ ...output, configured });
  } else if (configured && target) {
    logger.info(`Configured: "${target.account_name}" (${target.account_id}) — ${maskToken(target.api_key)}`);
  } else if (opts.accountId) {
    logger.info(`No token configured for account "${opts.accountId}".`);
  } else {
    logger.info('No Coolhand token is configured. Run `coolhand login` to authenticate.');
  }

  return configured ? ExitCode.OK : ExitCode.USER_ERROR;
}

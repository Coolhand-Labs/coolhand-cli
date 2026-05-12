import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { getAccount, loadConfig } from '../config.js';
import { maskToken } from '../mask.js';
import type { WhoamiOptions } from '../types.js';

export async function run(opts: WhoamiOptions): Promise<number> {
  const cfg = await loadConfig();
  const entry = getAccount(cfg, opts.accountId);

  if (!entry) {
    if (opts.accountId) {
      logger.info(`No account "${opts.accountId}" is configured.`);
    } else {
      logger.info('Not logged in. Run `coolhand login` to authenticate.');
    }
    return ExitCode.USER_ERROR;
  }

  logger.info(
    `Logged in as "${entry.account_name}" (id: ${entry.account_id}) via ${entry.base_url} — ${maskToken(entry.api_key)}`
  );
  return ExitCode.OK;
}

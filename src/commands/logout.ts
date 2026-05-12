import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { deleteConfig, loadConfig, removeAccount } from '../config.js';
import type { LogoutOptions } from '../types.js';

export async function run(opts: LogoutOptions): Promise<number> {
  if (opts.all) {
    await deleteConfig();
    if (opts.json) {
      logger.json({ ok: true, removed: 'all' });
    } else {
      logger.info('Removed all stored Coolhand accounts.');
    }
    return ExitCode.OK;
  }

  const cfg = await loadConfig();
  const targetId = opts.accountId ?? cfg.default_account_id;

  if (!targetId) {
    if (opts.json) {
      logger.json({ ok: true, removed: null, message: 'No accounts to remove.' });
    } else {
      logger.info('No accounts are configured.');
    }
    return ExitCode.OK;
  }

  const existed = Boolean(cfg.accounts[targetId]);
  await removeAccount(targetId);

  if (opts.json) {
    logger.json({ ok: true, removed: existed ? targetId : null });
  } else if (existed) {
    logger.info(`Removed account "${targetId}".`);
  } else {
    logger.info(`No account "${targetId}" was configured.`);
  }
  return ExitCode.OK;
}

import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { deleteConfig, loadConfig, removeClient } from '../config.js';
import type { LogoutOptions } from '../types.js';

export async function run(opts: LogoutOptions): Promise<number> {
  if (opts.all) {
    await deleteConfig();
    if (opts.json) {
      logger.json({ ok: true, removed: 'all' });
    } else {
      logger.info('Removed all stored Coolhand clients.');
    }
    return ExitCode.OK;
  }

  const cfg = await loadConfig();
  const targetId = opts.clientId ?? cfg.default_client_id;

  if (!targetId) {
    if (opts.json) {
      logger.json({ ok: true, removed: null, message: 'No clients to remove.' });
    } else {
      logger.info('No clients are configured.');
    }
    return ExitCode.OK;
  }

  const existed = Boolean(cfg.clients[targetId]);
  await removeClient(targetId);

  if (opts.json) {
    logger.json({ ok: true, removed: existed ? targetId : null });
  } else if (existed) {
    logger.info(`Removed client "${targetId}".`);
  } else {
    logger.info(`No client "${targetId}" was configured.`);
  }
  return ExitCode.OK;
}

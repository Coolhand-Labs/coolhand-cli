import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { getClient, loadConfig } from '../config.js';
import { maskToken } from '../mask.js';
import type { WhoamiOptions } from '../types.js';

export async function run(opts: WhoamiOptions): Promise<number> {
  const cfg = await loadConfig();
  const entry = getClient(cfg, opts.clientId);

  if (!entry) {
    if (opts.clientId) {
      logger.info(`No client "${opts.clientId}" is configured.`);
    } else {
      logger.info('Not logged in. Run `coolhand login` to authenticate.');
    }
    return ExitCode.USER_ERROR;
  }

  logger.info(
    `Logged in as "${entry.client_name}" (id: ${entry.client_id}) via ${entry.base_url} — ${maskToken(entry.api_key)}`
  );
  return ExitCode.OK;
}

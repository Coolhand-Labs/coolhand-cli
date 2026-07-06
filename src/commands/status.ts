import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { getClient, loadConfig } from '../config.js';
import { maskToken } from '../mask.js';
import type { StatusOptions, StatusOutput } from '../types.js';

export function buildStatusOutput(cfg: Awaited<ReturnType<typeof loadConfig>>): StatusOutput {
  const clients = Object.values(cfg.clients).map((entry) => ({
    client_id: entry.client_id,
    client_name: entry.client_name,
    masked_token: entry.api_key ? maskToken(entry.api_key) : '(no public key)',
    masked_private_key: entry.private_key ? maskToken(entry.private_key) : '(no private key)',
    base_url: entry.base_url,
  }));
  return {
    configured: clients.length > 0,
    clients,
    default_client_id: cfg.default_client_id,
  };
}

export async function run(opts: StatusOptions): Promise<number> {
  const cfg = await loadConfig();
  const output = buildStatusOutput(cfg);
  const target = getClient(cfg, opts.clientId);
  const configured = opts.clientId ? Boolean(target) : output.configured;

  if (opts.json) {
    logger.json({ ...output, configured });
  } else if (configured && target) {
    logger.info(
      `Configured: "${target.client_name}" (${target.client_id}) — ${target.api_key ? maskToken(target.api_key) : '(no public key)'}, ${target.private_key ? maskToken(target.private_key) : '(no private key)'}`
    );
  } else if (opts.clientId) {
    logger.info(`No token configured for client "${opts.clientId}".`);
  } else {
    logger.info('No Coolhand token is configured. Run `coolhand login` to authenticate.');
  }

  return configured ? ExitCode.OK : ExitCode.USER_ERROR;
}

import { CliError, ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { loadConfig, setDefault } from '../config.js';
import { maskToken } from '../mask.js';
import type { ClientsOptions } from '../types.js';
import { buildStatusOutput } from './status.js';

async function listClients(opts: ClientsOptions): Promise<number> {
  const cfg = await loadConfig();
  const output = buildStatusOutput(cfg);
  if (opts.json) {
    logger.json(output);
    return ExitCode.OK;
  }
  if (!output.configured) {
    logger.info('No clients configured. Run `coolhand login` to add one.');
    return ExitCode.OK;
  }
  for (const acct of output.clients) {
    const marker = acct.client_id === output.default_client_id ? '* ' : '  ';
    logger.info(
      `${marker}${acct.client_id}  ${acct.client_name}  ${acct.masked_token}  ${acct.masked_private_key}  ${acct.base_url}`
    );
  }
  return ExitCode.OK;
}

async function useClient(clientId: string, opts: ClientsOptions): Promise<number> {
  if (!clientId) {
    throw new CliError('INVALID_ARGS', 'clients use requires an client id');
  }
  const cfg = await setDefault(clientId);
  const entry = cfg.clients[clientId];
  if (opts.json) {
    logger.json({
      ok: true,
      default_client_id: cfg.default_client_id,
      client: {
        client_id: entry.client_id,
        client_name: entry.client_name,
        masked_token: entry.api_key ? maskToken(entry.api_key) : '(no public key)',
        masked_private_key: entry.private_key ? maskToken(entry.private_key) : '(no private key)',
        base_url: entry.base_url,
      },
    });
  } else {
    logger.info(`Default client is now "${entry.client_name}" (${entry.client_id}).`);
  }
  return ExitCode.OK;
}

export async function run(positional: string[], opts: ClientsOptions): Promise<number> {
  const sub = positional[0];
  if (!sub) {
    return listClients(opts);
  }
  if (sub === 'use') {
    return useClient(positional[1] ?? '', opts);
  }
  if (sub === 'list') {
    return listClients(opts);
  }
  throw new CliError('INVALID_ARGS', `Unknown clients subcommand: ${sub}`);
}

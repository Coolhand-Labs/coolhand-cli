import { HttpError, PublicContentService } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig } from '../config.js';
import { logger, stripAnsiEscapes } from '../logger.js';
import { ClientEntry, ConfigFile, DEFAULT_BASE_URL } from '../types.js';

export interface HelpCenterClient {
  service: PublicContentService;
  /** True when a stored client's key is sent; false when the call has no stored key (node may still
   *  add `COOLHAND_API_KEY` from the environment, except for a `--base-url` the key was not issued for). */
  usesStoredKey: boolean;
}

function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Picks the stored client whose key to send, without ever prompting or failing for lack of one:
 * `--client-id` (unknown id is an error, the user named it), then `COOLHAND_CLIENT_ID` and the
 * configured default (a stale value is ignored, the read is public), then the sole stored client.
 * Several clients with no usable default means anonymous rather than the interactive picker that
 * `resolveClient` would open.
 */
function selectStoredClient(cfg: ConfigFile, clientId?: string): ClientEntry | undefined {
  if (clientId !== undefined) {
    const entry = cfg.clients[clientId];
    if (!entry) {
      throw new CliError('CLIENT_NOT_FOUND', `No client "${clientId}" is configured.`);
    }
    return entry;
  }
  const preferred = [process.env.COOLHAND_CLIENT_ID, cfg.default_client_id];
  for (const id of preferred) {
    if (id && cfg.clients[id]) {
      return cfg.clients[id];
    }
  }
  const clients = Object.values(cfg.clients);
  return clients.length === 1 ? clients[0] : undefined;
}

/**
 * Builds the help center reader. Reads are public, so no stored client is not an error: the
 * service is constructed without a key and the call is anonymous. When a client is selected its key
 * is sent (it lifts the anonymous rate limit), unless `--base-url` points at a different server —
 * a stored key must never be sent to a host the user did not log in to, so in that case the call is
 * anonymous: the key is withheld and `COOLHAND_API_KEY` is not consulted either.
 */
export async function getHelpCenterClient(
  opts: { clientId?: string; baseUrl?: string } = {}
): Promise<HelpCenterClient> {
  if (opts.clientId === '') {
    throw new CliError('INVALID_ARGS', 'clientId must not be empty');
  }
  const cfg = await loadConfig();
  const client = selectStoredClient(cfg, opts.clientId);

  const baseUrl = opts.baseUrl ?? client?.base_url ?? DEFAULT_BASE_URL;
  const storedKey = client ? (client.api_key ?? client.private_key) : undefined;
  const keyAllowed = client !== undefined && sameServer(baseUrl, client.base_url);
  if (client && storedKey && !keyAllowed) {
    logger.warn(
      `Reading ${baseUrl} anonymously: client "${stripAnsiEscapes(client.client_name)}" is stored for ${client.base_url}, so its key is not sent.`
    );
  }
  const key = keyAllowed ? storedKey : undefined;
  if (client && key) {
    process.stderr.write(`Client: ${stripAnsiEscapes(client.client_name)} (${client.client_id})\n`);
  }

  try {
    // '' (not undefined) tells node not to fall back to COOLHAND_API_KEY for a host no key was issued for.
    const service = new PublicContentService({ apiKey: opts.baseUrl !== undefined && !keyAllowed ? '' : key, baseUrl, silent: true });
    return { service, usesStoredKey: key !== undefined };
  } catch (err) {
    throw new CliError('INVALID_BASE_URL', `Invalid base URL: ${baseUrl} (${(err as Error).message})`);
  }
}

/**
 * Maps an error thrown by a `PublicContentService` call to a `CliError`. A `401` means the key was
 * rejected and is reported, never retried anonymously. A `429` is the anonymous rate limit, so it
 * is retryable.
 */
export function mapHelpCenterHttpError(
  err: unknown,
  client: HelpCenterClient,
  notFoundMessage: string
): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      const hint = client.usesStoredKey
        ? "The stored API key was rejected. Run 'coolhand login' to re-authenticate."
        : 'The API key was rejected. Check COOLHAND_API_KEY, or unset it to read anonymously.';
      return new CliError('HELP_CENTER_ERROR', hint);
    }
    if (err.status === 404) {
      return new CliError('HELP_CENTER_ERROR', notFoundMessage);
    }
    if (err.status === 429) {
      return new CliError(
        'HELP_CENTER_ERROR',
        "Rate limit reached (anonymous callers get 30 requests per minute). Wait a minute and retry, or run 'coolhand login' to lift the limit."
      );
    }
    // coolhand-node already formats this as `Help center request failed (<status>): <body>`.
    return new CliError('HELP_CENTER_ERROR', err.message);
  }
  return new CliError('HELP_CENTER_ERROR', `Help center request failed: ${(err as Error).message}`);
}

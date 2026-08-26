import { Coolhand, HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';

/**
 * Resolves the CLI's stored client and returns a `Coolhand` instance authenticated with its
 * *private* key. `searchTemplates`/`getTemplate` require the private key — the public key used by
 * `monitor`/`logRequest` is write-only on this API and will 401 here.
 */
export async function getTemplateClient(opts: { clientId?: string } = {}): Promise<Coolhand> {
  const cfg = await loadConfig();
  const client = await resolveClient(cfg, opts.clientId);

  if (!client.private_key) {
    throw new CliError(
      'NO_PRIVATE_KEY',
      "No private key configured. Run 'coolhand login --scope private' first."
    );
  }

  try {
    // Coolhand validates baseUrl in its constructor (https required; http only for localhost).
    return new Coolhand({ apiKey: client.private_key, baseUrl: client.base_url, silent: true });
  } catch (err) {
    throw new CliError(
      'INVALID_BASE_URL',
      `Invalid base_url for client: ${client.base_url} (${(err as Error).message})`
    );
  }
}

/**
 * Maps an error thrown by `Coolhand#searchTemplates`/`getTemplate` to a `CliError`.
 *
 * A `504` is not a crash: both endpoints aggregate `log_count` over `llm_request_logs` under a
 * 10-second statement timeout, so a slow aggregate is expected and retryable. `timeoutHint` is the
 * caller's advice for making the same call cheaper, which differs between list and show.
 */
export function mapTemplateHttpError(
  err: unknown,
  notFoundMessage: string,
  timeoutHint: string
): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'TEMPLATE_ERROR',
        "The stored private key was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 404) {
      return new CliError('TEMPLATE_ERROR', notFoundMessage);
    }
    if (err.status === 504) {
      return new CliError(
        'TEMPLATE_ERROR',
        `The server timed out counting logs (log_count) for this request. ${timeoutHint}`
      );
    }
    // coolhand-node already formats this as `Template request failed (<status>): <body>`;
    // re-prefixing it here would print the status twice.
    return new CliError('TEMPLATE_ERROR', err.message);
  }
  return new CliError('TEMPLATE_ERROR', `Template request failed: ${(err as Error).message}`);
}

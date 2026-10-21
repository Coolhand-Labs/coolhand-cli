import { HttpError, PublicContentService } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig, resolveClientForDryRun } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';

export interface HelpCenterClient {
  service: PublicContentService;
  /** True when a stored client's key is sent; false when the call goes out with no key header
   *  (node may still add `COOLHAND_API_KEY` from the environment). */
  usesStoredKey: boolean;
}

function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Builds the help center reader. Reads are public, so no stored client is not an error: the
 * service is constructed without a key and the call is anonymous. When a client is stored its key
 * is sent (it lifts the anonymous rate limit), unless `--base-url` points at a different server —
 * a stored key must never be sent to a host the user did not log in to.
 */
export async function getHelpCenterClient(
  opts: { clientId?: string; baseUrl?: string } = {}
): Promise<HelpCenterClient> {
  const cfg = await loadConfig();
  const client = await resolveClientForDryRun(cfg, opts.clientId);

  const baseUrl = opts.baseUrl ?? client?.base_url ?? DEFAULT_BASE_URL;
  const key = client && sameServer(baseUrl, client.base_url) ? (client.api_key ?? client.private_key) : undefined;

  try {
    // PublicContentService validates baseUrl in its constructor (https required; http only for localhost).
    const service = new PublicContentService({ apiKey: key, baseUrl, silent: true });
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

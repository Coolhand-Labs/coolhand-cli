import { Coolhand, HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';

/**
 * Resolves the CLI's stored client and returns a `Coolhand` instance authenticated with its
 * *private* key. `getLogContent`/`searchLogs` require the private key — the public key used by
 * `monitor`/`logRequest` will 401 here.
 */
export async function getLogClient(opts: { clientId?: string } = {}): Promise<Coolhand> {
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
 * Maps an error thrown by `Coolhand#getLogContent`/`searchLogs` to a `CliError` with a clear,
 * actionable message — a 401 means the stored private key was rejected (mirrors `feedback-client.ts`'s
 * hint), a 404 uses the caller-supplied message (e.g. `Log "x" not found`).
 */
export function mapLogHttpError(err: unknown, notFoundMessage: string): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'LOG_ERROR',
        "The stored private key was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 404) {
      return new CliError('LOG_ERROR', notFoundMessage);
    }
    return new CliError('LOG_ERROR', `Log request failed (${err.status}): ${err.message}`);
  }
  return new CliError('LOG_ERROR', `Log request failed: ${(err as Error).message}`);
}

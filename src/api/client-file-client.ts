import { Coolhand, HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';

/**
 * Resolves the CLI's stored client and returns a `Coolhand` instance authenticated with its
 * stored *private* key. `listClientFiles`/`downloadClientFile`/`updateClientFileStatus` need more
 * than a private key: it must be the per-user key of a client admin of the client, which is what
 * `coolhand login --scope private` stores. The client-level key, the public key and OAuth tokens
 * are refused.
 */
export async function getClientFileClient(opts: { clientId?: string } = {}): Promise<Coolhand> {
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
 * Maps an error thrown by the client-file SDK methods to a `CliError`. A 401 means the stored key
 * was missing or rejected; a 403 means it authenticated but is not a client admin's per-user key;
 * a 404 uses the caller-supplied message (an unknown id and another client's id look the same).
 */
export function mapClientFileHttpError(err: unknown, notFoundMessage: string): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'CLIENT_FILE_ERROR',
        "The stored private key was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 403) {
      return new CliError(
        'CLIENT_FILE_ERROR',
        "Client files can only be managed with a client admin's per-user private key, and the stored key " +
          "was refused. Run 'coolhand login --scope private' as a client admin of this client."
      );
    }
    if (err.status === 404) {
      return new CliError('CLIENT_FILE_ERROR', notFoundMessage);
    }
    // coolhand-node already formats this as `Client file request failed (<status>): <body>`.
    return new CliError('CLIENT_FILE_ERROR', err.message);
  }
  return new CliError('CLIENT_FILE_ERROR', `Client file request failed: ${(err as Error).message}`);
}

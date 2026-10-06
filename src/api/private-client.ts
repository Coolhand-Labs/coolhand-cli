import { Coolhand } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';

/**
 * Resolves the CLI's stored client and returns a `Coolhand` instance authenticated with its
 * *private* key. The read endpoints (templates, logs, workloads) require it — the public key used
 * by `monitor`/`logRequest` is write-only on this API and will 401 here.
 */
export async function getPrivateClient(opts: { clientId?: string } = {}): Promise<Coolhand> {
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

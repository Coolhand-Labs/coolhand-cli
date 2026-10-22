import { HttpError, type Coolhand } from 'coolhand-node';
import { CliError } from '../errors.js';
import { getTemplateClient } from './template-client.js';

/**
 * `searchWorkloads` needs the same private-key `Coolhand` instance as the template endpoints, so
 * this delegates rather than duplicating the key/base-URL handling.
 */
export function getWorkloadClient(opts: { clientId?: string } = {}): Promise<Coolhand> {
  return getTemplateClient(opts);
}

/**
 * Maps an error thrown by `Coolhand#searchWorkloads` to a `CliError`. A `422` (bad `--since`/
 * `--until`/`--days-back` with `--include-metrics`) falls through to `err.message`, which
 * coolhand-node already formats with the server's `errors` body.
 */
export function mapWorkloadHttpError(err: unknown): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'WORKLOAD_ERROR',
        "A private API key is required, and the stored one was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 504) {
      return new CliError(
        'WORKLOAD_ERROR',
        'The server timed out computing this request. It is retryable — narrow it with --search or a smaller --per-page, then retry.'
      );
    }
    return new CliError('WORKLOAD_ERROR', err.message);
  }
  return new CliError('WORKLOAD_ERROR', `Workload request failed: ${(err as Error).message}`);
}

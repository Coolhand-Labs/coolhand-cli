import { HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';

export { getPrivateClient as getWorkloadClient } from './private-client.js';

/**
 * Maps an error thrown by `Coolhand#searchWorkloads` to a `CliError`. A `422` (bad `--since`/
 * `--until`/`--days-back`) and every other non-2xx pass the server's message through; a `504` is a
 * retryable aggregate timeout, not a crash.
 */
export function mapWorkloadHttpError(err: unknown): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'WORKLOAD_ERROR',
        "A private API key is required, and the stored key was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 504) {
      return new CliError(
        'WORKLOAD_ERROR',
        'The server timed out computing metrics for this request. Narrow it with --search, a smaller --per-page or a shorter --since/--until window, or drop --include-metrics, then retry.'
      );
    }
    return new CliError('WORKLOAD_ERROR', err.message);
  }
  return new CliError('WORKLOAD_ERROR', `Workload request failed: ${(err as Error).message}`);
}

import { HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';

export { getPrivateClient as getLogClient } from './private-client.js';

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
    if (err.status === 504) {
      return new CliError(
        'LOG_ERROR',
        'The server timed out. It is retryable — try again, or narrow the request (for search-logs: a shorter --since/--until window, more filters, or a smaller --per-page).'
      );
    }
    // coolhand-node already formats this as `Log request failed (<status>): <body>`.
    return new CliError('LOG_ERROR', err.message);
  }
  return new CliError('LOG_ERROR', `Log request failed: ${(err as Error).message}`);
}

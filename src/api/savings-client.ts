import { HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';

/**
 * Maps an error thrown by `Coolhand#getRealizedSavings` to a `CliError`. The client itself comes
 * from `getTemplateClient` (same private-key `Coolhand` instance).
 *
 * A `503` means the comparison could not be computed. It is retryable and must never read as zero
 * savings, so it always becomes an error.
 */
export function mapSavingsHttpError(err: unknown): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'SAVINGS_ERROR',
        "A private API key is required, and the stored one was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 503) {
      return new CliError(
        'SAVINGS_ERROR',
        'Realized savings could not be computed right now (retryable). Wait a moment, then run the command again.'
      );
    }
    return new CliError('SAVINGS_ERROR', err.message);
  }
  return new CliError('SAVINGS_ERROR', `Savings request failed: ${(err as Error).message}`);
}

import { HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';

export { getPrivateClient as getTemplateClient } from './private-client.js';

/**
 * Maps an error thrown by `Coolhand#searchTemplates`/`getTemplate` to a `CliError`.
 *
 * A `504` is not a crash: both endpoints aggregate `log_count` and the window metrics over
 * `llm_request_logs` under a 10-second statement timeout, so a slow aggregate is expected and retryable. `timeoutHint` is the
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
        `The server timed out computing log counts and metrics for this request. ${timeoutHint}`
      );
    }
    // coolhand-node already formats this as `Template request failed (<status>): <body>`;
    // re-prefixing it here would print the status twice.
    return new CliError('TEMPLATE_ERROR', err.message);
  }
  return new CliError('TEMPLATE_ERROR', `Template request failed: ${(err as Error).message}`);
}

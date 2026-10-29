import { HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';

/**
 * Maps an error thrown by `Coolhand#listStepTemplates`/`getStepTemplate` to a `CliError`. The client
 * itself comes from `getTemplateClient` — step templates use the same private-key `Coolhand` instance.
 *
 * A `504` is a statement timeout and retryable; `timeoutHint` is the caller's advice for making the
 * same call cheaper, which differs between list and show.
 */
export function mapStepTemplateHttpError(
  err: unknown,
  notFoundMessage: string,
  timeoutHint: string
): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'STEP_TEMPLATE_ERROR',
        "The stored private key was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 404) {
      return new CliError('STEP_TEMPLATE_ERROR', notFoundMessage);
    }
    if (err.status === 422) {
      return new CliError(
        'STEP_TEMPLATE_ERROR',
        `The server rejected the request (422); --step-type must be prompt_step or tool_step. ${err.message}`
      );
    }
    if (err.status === 504) {
      return new CliError(
        'STEP_TEMPLATE_ERROR',
        `The server timed out computing this request (retryable). ${timeoutHint}`
      );
    }
    return new CliError('STEP_TEMPLATE_ERROR', err.message);
  }
  return new CliError('STEP_TEMPLATE_ERROR', `Step template request failed: ${(err as Error).message}`);
}

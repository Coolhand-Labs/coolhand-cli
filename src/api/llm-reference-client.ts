import { Coolhand, HttpError } from 'coolhand-node';
import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';

/**
 * Resolves the CLI's stored client and returns a `Coolhand` instance authenticated with its
 * *private* key. `searchReferencedFiles`/`listReferencedFileSessions` require the private key —
 * the public key used for LLM capture is write-only on this API and 401s here.
 */
export async function getLlmReferenceClient(opts: { clientId?: string } = {}): Promise<Coolhand> {
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
 * Maps an error thrown by `Coolhand#searchReferencedFiles`/`listReferencedFileSessions` to a
 * `CliError` — a 401 means the stored private key was rejected (mirrors `log-client.ts`'s hint), a
 * 504 means the query exceeded the backend's statement timeout and is retryable, not a bug. Any
 * other status (e.g. 422 for an unrecognized filter or non-scalar param) surfaces the server's own
 * message rather than swallowing it.
 *
 * Both endpoints can 504 — `searchReferencedFiles` on its GROUP BY aggregate, and
 * `listReferencedFileSessions` on the pagination `COUNT(*)` for a very hot `file_path` — but they
 * have different flags to retry with, so `timeoutHint` is caller-supplied (same shape as
 * `mapFeedbackHttpError`'s `notFoundMessage`). Suggesting a flag the invoking command doesn't
 * define would be a silent no-op: the arg parser accepts unknown flags without complaint.
 */
export function mapLlmReferenceHttpError(err: unknown, timeoutHint: string): CliError {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return new CliError(
        'LLM_REFERENCE_ERROR',
        "The stored private key was rejected. Run 'coolhand login --scope private' to re-authenticate."
      );
    }
    if (err.status === 504) {
      return new CliError(
        'LLM_REFERENCE_ERROR',
        `Referenced file request timed out (504): the query exceeded the backend's statement ` +
          `timeout. This is retryable — ${timeoutHint}.`
      );
    }
    return new CliError('LLM_REFERENCE_ERROR', `Referenced file request failed (${err.status}): ${err.message}`);
  }
  return new CliError('LLM_REFERENCE_ERROR', `Referenced file request failed: ${(err as Error).message}`);
}

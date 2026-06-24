import { Coolhand, type CoolhandCallData } from 'coolhand-node';
import { CliError } from './errors.js';
import { loadConfig, getClient } from './config.js';
import { DEFAULT_BASE_URL } from './types.js';

/** Identifies submissions from this tool in the server's collector field. */
const COLLECTOR = 'coolhand-cli/claude-code';

/**
 * Submit one captured request/response envelope to the Coolhand ingest endpoint.
 *
 * Transport is delegated to coolhand-node's `Coolhand#logRequest`, which posts to the same
 * `/api/v2/llm_request_logs` endpoint with the client's public `api_key`. The server
 * deduplicates by the envelope's `response_body.id`, so re-submitting the same turn is harmless.
 *
 * The SDK swallows submission failures and returns `null`; we translate that (and a base_url
 * rejection from the SDK constructor) back into a `CliError` so `analyze-claude-sessions` keeps its
 * per-session success/failure accounting intact.
 */
export async function logRequest(
  rawRequest: unknown,
  opts: { clientId?: string } = {}
): Promise<unknown> {
  const cfg = await loadConfig();
  const client = getClient(cfg, opts.clientId);

  if (opts.clientId && !client) {
    throw new CliError('CLIENT_NOT_FOUND', `No client "${opts.clientId}" is configured.`);
  }

  const apiKey = client?.api_key ?? process.env.COOLHAND_API_KEY;
  if (!apiKey) {
    throw new CliError(
      'NOT_CONFIGURED',
      'Not logged in. Run `coolhand login` to authenticate.'
    );
  }

  const baseUrl = client?.base_url ?? DEFAULT_BASE_URL;

  let coolhand: Coolhand;
  try {
    // The SDK validates baseUrl in its constructor (https required; http only for localhost).
    coolhand = new Coolhand({ apiKey, baseUrl, silent: true });
  } catch (err) {
    throw new CliError('INVALID_BASE_URL', `Invalid base_url for client: ${baseUrl} (${(err as Error).message})`);
  }

  let result: unknown;
  try {
    result = await coolhand.logRequest(rawRequest as CoolhandCallData, { collector: COLLECTOR });
  } catch (err) {
    throw new CliError('INGEST_ERROR', `Log submission failed: ${(err as Error).message}`);
  }

  // The SDK returns null when the POST fails (it reports the error itself). On Node >= 20 (our
  // engine floor) fetch is always defined, so a null result here unambiguously means failure.
  if (result === null) {
    throw new CliError('INGEST_ERROR', 'Log submission failed.');
  }

  return result;
}

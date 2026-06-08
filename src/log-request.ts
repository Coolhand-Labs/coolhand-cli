import { CliError } from './errors.js';
import { loadConfig, getClient } from './config.js';
import { DEFAULT_BASE_URL } from './types.js';

/** Identifies submissions from this tool in the server's collector field. */
const COLLECTOR = 'coolhand-cli/claude-code';

/**
 * Submit one captured request/response envelope to the Coolhand ingest endpoint.
 *
 * Mirrors `mcp-call.ts`, but posts to the REST log endpoint instead of the MCP endpoint and
 * authenticates with the client's public `api_key`. The server deduplicates by the envelope's
 * `response_body.id`, so re-submitting the same turn is harmless.
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
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new CliError('INVALID_BASE_URL', `Invalid base_url for client: ${baseUrl}`);
  }
  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new CliError('INVALID_BASE_URL', `base_url must be http or https, got: ${parsedBaseUrl.protocol}`);
  }
  const url = new URL('/api/v2/llm_request_logs', parsedBaseUrl).toString();

  const body = {
    llm_request_log: {
      raw_request: rawRequest,
      collector: COLLECTOR,
    },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError('INGEST_ERROR', `Log submission failed: ${(err as Error).message}`);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new CliError('INGEST_ERROR', `Log submission failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('INGEST_ERROR', `Log response was not valid JSON: ${text.slice(0, 2000)}`);
  }
}

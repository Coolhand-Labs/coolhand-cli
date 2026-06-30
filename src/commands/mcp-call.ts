import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';

export async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  opts: { clientId?: string } = {}
): Promise<unknown> {
  const cfg = await loadConfig();

  const hasStoredClients = Object.keys(cfg.clients).length > 0;
  const envPrivateKey = process.env.COOLHAND_PRIVATE_KEY;

  let privateKey: string;
  let baseUrl: string;

  try {
    const client = await resolveClient(cfg, opts.clientId);
    if (!client.private_key) {
      throw new CliError(
        'NO_PRIVATE_KEY',
        "No private key configured. Run 'coolhand login --scope private' first."
      );
    }
    privateKey = client.private_key;
    baseUrl = client.base_url;
  } catch (err) {
    // Zero-config fallback: when there are no stored clients, fall back to
    // COOLHAND_PRIVATE_KEY (raw env key). Catches both NOT_CONFIGURED (no clients at
    // all) and CLIENT_NOT_FOUND (COOLHAND_CLIENT_ID set to a name that doesn't exist
    // in an otherwise empty config) so that a stale env var doesn't defeat the fallback.
    if (
      err instanceof CliError &&
      (err.code === 'NOT_CONFIGURED' || err.code === 'CLIENT_NOT_FOUND') &&
      !hasStoredClients &&
      envPrivateKey
    ) {
      privateKey = envPrivateKey;
      baseUrl = DEFAULT_BASE_URL;
    } else {
      throw err;
    }
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new CliError('INVALID_BASE_URL', `Invalid base_url for client: ${baseUrl}`);
  }
  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new CliError('INVALID_BASE_URL', `base_url must be http or https, got: ${parsedBaseUrl.protocol}`);
  }
  const url = new URL('/mcp', parsedBaseUrl).toString();

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': privateKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError('MCP_ERROR', `MCP request failed: ${(err as Error).message}`);
  }

  const text = await res.text().catch(() => '');
  const snippet = text.slice(0, 2000);
  if (!res.ok) {
    throw new CliError('MCP_ERROR', `MCP request failed (${res.status}): ${snippet}`);
  }

  let json: { result?: unknown; error?: { message?: string } };
  try {
    json = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new CliError('MCP_ERROR', `MCP response was not valid JSON: ${snippet}`);
  }

  if (json.error) {
    throw new CliError('MCP_ERROR', `MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  return json.result;
}

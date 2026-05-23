import { CliError } from '../errors.js';
import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';

export async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  opts: { clientId?: string } = {}
): Promise<unknown> {
  const cfg = await loadConfig();
  const client = getClient(cfg, opts.clientId);

  if (opts.clientId && !client) {
    throw new CliError('CLIENT_NOT_FOUND', `No client "${opts.clientId}" is configured.`);
  }

  if (!client && !process.env.COOLHAND_PRIVATE_KEY) {
    throw new CliError(
      'NOT_CONFIGURED',
      'Not logged in. Run `coolhand login --scope private` to authenticate.'
    );
  }

  const privateKey = opts.clientId ? client?.private_key : (client?.private_key ?? process.env.COOLHAND_PRIVATE_KEY);
  if (!privateKey) {
    throw new CliError(
      'NO_PRIVATE_KEY',
      "No private key configured. Run 'coolhand login --scope private' first."
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
  const url = `${baseUrl}/mcp`;

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

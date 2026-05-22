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

  const privateKey = client?.private_key ?? process.env.COOLHAND_PRIVATE_KEY;
  if (!privateKey) {
    throw new CliError(
      'NO_PRIVATE_KEY',
      "No private key configured. Run 'coolhand login --scope private' first."
    );
  }

  const baseUrl = client?.base_url ?? DEFAULT_BASE_URL;
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
  if (!res.ok) {
    throw new CliError('MCP_ERROR', `MCP request failed (${res.status}): ${text}`);
  }

  let json: { result?: unknown; error?: { message?: string } };
  try {
    json = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new CliError('MCP_ERROR', `MCP response was not valid JSON: ${text}`);
  }

  if (json.error) {
    throw new CliError('MCP_ERROR', `MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  return json.result;
}

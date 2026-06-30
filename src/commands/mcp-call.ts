import { CliError } from '../errors.js';
import { loadConfig, resolveClient } from '../config.js';
import { type ClientEntry, DEFAULT_BASE_URL } from '../types.js';

export async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  opts: { clientId?: string } = {}
): Promise<unknown> {
  const cfg = await loadConfig();

  const hasStoredClients = Object.keys(cfg.clients).length > 0;
  const envPrivateKey = process.env.COOLHAND_PRIVATE_KEY;

  // Resolve the client. The catch only handles resolveClient failures — the
  // NO_PRIVATE_KEY check is intentionally outside this try so unrelated throws
  // don't accidentally pass through the fallback guard.
  let resolvedClient: ClientEntry | undefined;
  try {
    resolvedClient = await resolveClient(cfg, opts.clientId);
  } catch (err) {
    // Zero-config fallback: when there are no stored clients, fall back to
    // COOLHAND_PRIVATE_KEY (raw env key). Guards:
    //  - opts.clientId must be undefined: an explicit --client-id flag names a specific
    //    account, so silently falling back would be confusing.
    //  - COOLHAND_CLIENT_ID must not be set: if the user set the env var, that is an
    //    intentional selection we should not silently override.
    //  - !hasStoredClients: if clients ARE stored, resolution failure (e.g. no default,
    //    non-TTY) should surface, not fall back to env key.
    // With all three guards true, resolveClient can only throw NOT_CONFIGURED (no stored
    // clients → no client to find), never CLIENT_NOT_FOUND.
    if (
      err instanceof CliError &&
      err.code === 'NOT_CONFIGURED' &&
      opts.clientId === undefined &&
      !process.env.COOLHAND_CLIENT_ID &&
      !hasStoredClients &&
      envPrivateKey
    ) {
      // resolvedClient stays undefined — handled in the branch below
    } else {
      throw err;
    }
  }

  let privateKey: string;
  let baseUrl: string;

  if (resolvedClient !== undefined) {
    if (!resolvedClient.private_key) {
      throw new CliError(
        'NO_PRIVATE_KEY',
        "No private key configured. Run 'coolhand login --scope private' first."
      );
    }
    privateKey = resolvedClient.private_key;
    baseUrl = resolvedClient.base_url;
  } else {
    // Zero-config fallback path: envPrivateKey is guaranteed non-null here because
    // the catch condition above requires it (the catch would have re-thrown otherwise).
    privateKey = envPrivateKey as string;
    baseUrl = DEFAULT_BASE_URL;
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

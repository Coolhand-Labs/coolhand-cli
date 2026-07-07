import { McpService } from 'coolhand-node';
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
    // With all three guards true (no explicit clientId, no COOLHAND_CLIENT_ID, no stored
    // clients), the priority chain skips steps 1–3 and falls to step 4 (no clients), so
    // resolveClient throws NOT_CONFIGURED. CLIENT_NOT_FOUND is not reachable here because
    // that requires an explicit selection (step 1 or 2) which the guards above rule out.
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
  let mcp: McpService;
  try {
    // McpService's constructor rejects a bad base_url (https required; http only for localhost).
    mcp = new McpService({ apiKey: privateKey, baseUrl, silent: true });
  } catch (err) {
    throw new CliError('INVALID_BASE_URL', `Invalid base_url for client: ${baseUrl} (${(err as Error).message})`);
  }

  try {
    return await mcp.mcpCall(toolName, args);
  } catch (err) {
    // A 401 means the stored private key was rejected. Re-add the login hint that
    // lived in the CLI before /mcp moved into coolhand-node.
    const status = (err as { status?: number }).status;
    const hint =
      status === 401
        ? " The stored private key was rejected. Run 'coolhand login --scope private' to re-authenticate."
        : '';
    throw new CliError('MCP_ERROR', `${(err as Error).message}${hint}`);
  }
}

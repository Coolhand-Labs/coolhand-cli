import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';

/**
 * Ask the server for the timestamp of the most recent Claude Code log it already holds, so
 * `capture-sessions` only re-scans files newer than that. This is a server-authoritative cutoff that
 * survives local state-file loss or a reinstall.
 *
 * Queries the `/api/v2/llm_request_logs` index for the single newest `claude_code` row. The server
 * has no default sort, so newest-first is requested explicitly via `q[s]`. Index reads require the
 * client's PRIVATE key (`private_key`, or the `COOLHAND_PRIVATE_KEY` env var); the public ingest
 * key is write-only and the server answers it with a 401.
 *
 * It NEVER throws: any problem (no private key, bad base url, 401, network failure, non-JSON body,
 * an empty result set, or an invalid `created_at`) returns `null` so the caller can fall back to
 * local state.
 *
 * `opts.clientId` is expected to be an **already-resolved** `client_id` string (e.g. from
 * `resolveClient`), not a raw user input. `getClient` is used here deliberately: by the time this
 * is called the client has already been selected (or is undefined for dry-run), so re-running the
 * full resolution chain would be redundant and could trigger a second TTY prompt.
 */
export async function fetchLastSync(opts: { clientId?: string } = {}): Promise<Date | null> {
  let apiKey: string | undefined;
  let baseUrl: string;
  try {
    const cfg = await loadConfig();
    const client = getClient(cfg, opts.clientId);
    apiKey = client?.private_key ?? process.env.COOLHAND_PRIVATE_KEY;
    baseUrl = client?.base_url ?? DEFAULT_BASE_URL;
  } catch {
    return null;
  }
  if (!apiKey) {
    return null;
  }

  let url: string;
  try {
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
      return null;
    }
    const endpoint = new URL('/api/v2/llm_request_logs', parsedBaseUrl);
    endpoint.searchParams.set('q[source_api_in][]', 'claude_code');
    endpoint.searchParams.set('q[s]', 'created_at desc');
    endpoint.searchParams.set('per', '1');
    url = endpoint.toString();
  } catch {
    return null;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
    });
  } catch {
    // Network failure — degrade to local state.
    return null;
  }
  if (!res.ok) {
    // 401 (key lacks read access) or any other non-2xx — degrade to local state.
    return null;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  // The index returns a bare JSON array; an empty one means the server holds no
  // claude_code logs for this client yet.
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  const newest = body[0];
  if (newest === null || typeof newest !== 'object') {
    return null;
  }
  const createdAt = (newest as { created_at?: unknown }).created_at;
  if (typeof createdAt !== 'string') {
    return null;
  }
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

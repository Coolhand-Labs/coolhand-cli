import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';
import { PACKAGE_IDENTIFIER } from '../version.js';

/** Identifies this tool's logs in the server's collector field (matches the ingest collector). */
const COLLECTOR = `${PACKAGE_IDENTIFIER}/claude-code`;

/**
 * Ask the server for the timestamp of the most recent log it already holds from this collector, so
 * `capture-sessions` only re-scans files newer than that. This is a server-authoritative cutoff that
 * survives local state-file loss or a reinstall.
 *
 * It NEVER throws: any problem (no api key, bad base url, 404, network failure, non-JSON body, or a
 * missing/invalid `last_created_at`) returns `null` so the caller can fall back to local state. The
 * companion server endpoint may not exist yet; a 404 is therefore an expected, non-fatal outcome.
 *
 * Auth mirrors the ingest path (`log-request.ts`): the public `api_key` sent as `X-API-Key`, since
 * the endpoint lives on the same `/api/v2/llm_request_logs` path.
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
    apiKey = client?.api_key ?? process.env.COOLHAND_API_KEY;
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
    const endpoint = new URL('/api/v2/llm_request_logs/last_sync', parsedBaseUrl);
    endpoint.searchParams.set('collector', COLLECTOR);
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
    // 404 (endpoint not built yet) or any other non-2xx — degrade to local state.
    return null;
  }

  let body: { last_created_at?: string | null };
  try {
    body = (await res.json()) as { last_created_at?: string | null };
  } catch {
    return null;
  }

  if (typeof body.last_created_at !== 'string') {
    return null;
  }
  const date = new Date(body.last_created_at);
  return Number.isNaN(date.getTime()) ? null : date;
}

import { Coolhand, type CoolhandCallData, type LLMRequestLogFeedback } from 'coolhand-node';
import { loadConfig, getClient } from './config.js';
import { DEFAULT_BASE_URL } from './types.js';
import type { PendingRecord } from './pending-store.js';

/**
 * Send a single saved record to Coolhand. Resolves the api key/base url from the record itself when
 * it carries one (hook-spooled turns do), otherwise from the stored client (or env) at flush time —
 * by now the user is logged in. Returns true only when the server confirms the write; the SDK
 * returns null (it does not throw) on a failed write, so a falsy result means "keep the file and
 * retry later".
 */
export async function uploadRecord(record: PendingRecord, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  // A record that carries its own key (hook-spooled turns) never touches the stored config, so an
  // unreadable config.json can't stop it from being replayed.
  const client = record.apiKey ? undefined : getClient(await loadConfig(), record.clientId);
  const apiKey = record.apiKey ?? client?.api_key ?? process.env.COOLHAND_API_KEY;
  if (!apiKey) {
    return false;
  }
  const baseUrl = record.baseUrl ?? client?.base_url ?? DEFAULT_BASE_URL;

  let coolhand: Coolhand;
  try {
    // requestTimeoutMs makes the SDK abort the request itself, not just stop us waiting for it.
    coolhand = new Coolhand({ apiKey, baseUrl, silent: true, ...(opts.timeoutMs ? { requestTimeoutMs: opts.timeoutMs } : {}) });
  } catch {
    return false;
  }

  if (record.kind === 'feedback') {
    const result = await coolhand.createFeedback(record.payload as LLMRequestLogFeedback);
    return result !== null && result !== undefined;
  }
  if (record.kind === 'turn') {
    const { envelope, collector, metadata } = record.payload as {
      envelope: CoolhandCallData;
      collector?: string;
      metadata?: Record<string, unknown>;
    };
    // A replay may duplicate a turn that actually landed (the server does not dedup), so mark it for consumers.
    const result = await coolhand.logRequest(envelope, {
      collector,
      metadata: {
        ...metadata,
        replayed: true,
        replay_attempt: (record.attempts ?? 0) + 1,
        // The original send timed out rather than being refused, so it may already be stored.
        ...(record.ambiguous ? { possible_duplicate: true } : {}),
      },
    });
    return result !== null && result !== undefined;
  }
  return false;
}

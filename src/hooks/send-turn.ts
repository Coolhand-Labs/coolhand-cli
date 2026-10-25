import { promises as fs } from 'fs';
import { Coolhand, type CoolhandCallData } from 'coolhand-node';
import { CliError } from '../errors.js';
import { DEFAULT_BASE_URL } from '../types.js';
import {
  listTurnFiles,
  readPendingRecord,
  removePendingRecord,
  savePendingRecord,
  TURN_RECORD_COMMAND,
} from '../pending-store.js';
import { uploadRecord } from '../pending-upload.js';

/** A hook runs on the agent's clock; never hold it longer than this. */
const SEND_TIMEOUT_MS = 5000;
/** Spooled turns replayed per successful send, so a long outage drains over a few turns. */
const RETRY_BATCH = 10;
/** Give up on a replay run after this many failures in a row (the network is probably down). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** A spooled turn older than this is dropped, as is anything beyond the newest MAX_SPOOLED. */
const SPOOL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SPOOLED = 200;
/** Total wall-clock budget for one replay run, so slow-but-answering servers can't hold the hook open. */
const REPLAY_BUDGET_MS = 15_000;

export interface SendTurnOptions {
  apiKey: string;
  baseUrl?: string;
  collector: string;
  metadata: Record<string, unknown>;
  /** Per-request cap in ms. Defaults to 5 seconds; tests shorten it. */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * Bound the spool. The SDK reports every failure the same way (null), so a turn the server will
 * never accept (revoked key, oversized body) looks just like an outage; without a cap such turns —
 * each holding the key and the turn text — would pile up forever.
 */
async function pruneSpool(): Promise<void> {
  const files = await listTurnFiles();
  const now = Date.now();
  const kept: string[] = [];
  for (const file of files) {
    try {
      if (now - (await fs.stat(file)).mtimeMs > SPOOL_TTL_MS) {
        await removePendingRecord(file);
        continue;
      }
      kept.push(file);
    } catch {
      // Vanished underneath us.
    }
  }
  for (const file of kept.slice(0, Math.max(0, kept.length - MAX_SPOOLED))) {
    await removePendingRecord(file);
  }
}

/**
 * Re-send turns spooled by earlier failures, NEWEST first: after a key rotation the old records carry
 * a dead key and fail forever, and the turns that matter are the recent ones behind them. One record
 * the server keeps refusing doesn't block the rest; the run stops after several failures in a row.
 * The spool is pruned first so stale records age out even when every send succeeds.
 */
export async function replaySpooledTurns(timeoutMs: number = SEND_TIMEOUT_MS): Promise<void> {
  await pruneSpool();
  const files = (await listTurnFiles()).reverse();
  const deadline = Date.now() + REPLAY_BUDGET_MS;
  let attempted = 0;
  let failures = 0;
  for (const file of files) {
    if (attempted >= RETRY_BATCH || failures >= MAX_CONSECUTIVE_FAILURES || Date.now() >= deadline) {
      return;
    }
    attempted += 1;
    try {
      const record = await readPendingRecord(file);
      if (record.kind === 'turn' && (await withTimeout(uploadRecord(record, { timeoutMs }), timeoutMs))) {
        await removePendingRecord(file);
        failures = 0;
      } else {
        failures += 1;
      }
    } catch {
      failures += 1;
    }
  }
}

/**
 * Send one turn envelope to Coolhand with the supplied public key. On any failure (network, timeout,
 * server refusal) the turn is spooled to `~/.coolhand/pending/` carrying the key and base url, so it
 * is replayed (see {@link replaySpooledTurns}, which the caller runs after a successful send), without a login.
 * Returns `'sent'` or `'spooled'`. Throws only for an unusable `baseUrl`.
 */
export async function sendTurn(envelope: unknown, opts: SendTurnOptions): Promise<'sent' | 'spooled'> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  let coolhand: Coolhand;
  try {
    // The SDK validates baseUrl in its constructor (https required; http only for localhost).
    coolhand = new Coolhand({ apiKey: opts.apiKey, baseUrl, silent: true, requestTimeoutMs: timeoutMs });
  } catch (err) {
    throw new CliError('INVALID_BASE_URL', `Invalid base url: ${baseUrl} (${(err as Error).message})`);
  }

  const result = await withTimeout(
    coolhand.logRequest(envelope as CoolhandCallData, { collector: opts.collector, metadata: opts.metadata }),
    timeoutMs
  );

  if (result === null || result === undefined) {
    await savePendingRecord({
      command: TURN_RECORD_COMMAND,
      kind: 'turn',
      payload: { envelope, collector: opts.collector, metadata: opts.metadata },
      apiKey: opts.apiKey,
      baseUrl,
      savedAt: new Date().toISOString(),
    });
    // Housekeeping must not change the outcome: the turn is already safely spooled.
    await pruneSpool().catch(() => undefined);
    return 'spooled';
  }

  return 'sent';
}

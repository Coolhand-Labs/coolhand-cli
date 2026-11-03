import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { atomicWriteFile } from '../config.js';
import { logHookEvent } from './hook-log.js';
import { Coolhand, type DeclaredContext } from 'coolhand-node';
import { logTurn } from './log-turn.js';
import { CliError } from '../errors.js';
import { DEFAULT_BASE_URL } from '../types.js';
import {
  listTurnFiles,
  pendingDir,
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
/** Total size cap on the spool: each turn now carries the conversation so far and can be several hundred KB. */
const MAX_SPOOL_BYTES = 64 * 1024 * 1024;
/** Total wall-clock budget for one replay run, so slow-but-answering servers can't hold the hook open. */
const REPLAY_BUDGET_MS = 15_000;
/** Don't start a replay upload with less budget than this left. */
const MIN_UPLOAD_MS = 1_000;
/** A spooled turn is dropped after this many failed replays. */
const MAX_REPLAY_ATTEMPTS = 3;
/** A record being replayed is renamed to `<name>.json.claim`; a claim this old belongs to a dead process. */
const CLAIM_SUFFIX = '.claim';
const STALE_CLAIM_MS = 60_000;

export interface SendTurnOptions {
  apiKey: string;
  baseUrl?: string;
  collector: string;
  metadata: Record<string, unknown>;
  /** Per-request cap in ms. Defaults to 5 seconds; tests shorten it. */
  timeoutMs?: number;
  /** The workload to declare for this log (workload only; no template). Kept with a spooled turn so its replay declares it too. */
  declared?: DeclaredContext;
  /** Which session and turn this is, so older spooled turns of the same session can be discarded. */
  session?: string;
  turn?: number;
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

/** Short stable label for a session, used in spool file names (`.s<hash>-t<turn>.json`). */
function sessionTag(sessionId: string): string {
  return `s${createHash('sha1').update(sessionId).digest('hex').slice(0, 10)}`;
}

function parseTurnTag(file: string): { session: string; turn: number } | undefined {
  const match = /\.(s[0-9a-f]{10})-t(\d+)\.json$/.exec(path.basename(file));
  return match ? { session: match[1], turn: Number(match[2]) } : undefined;
}

/**
 * Each turn carries the whole conversation so far and the server keeps only a session's newest turn,
 * so a spooled turn is pointless once a newer turn of the same session has been DELIVERED: its text is
 * already in that one, and replaying it would only burn upload time and attempts. (Only delivery
 * counts: a newer turn that is merely spooled can still be refused and dropped, so its predecessor
 * stays until it lands.) `floors` maps a session tag to
 * the turn number below which its spooled turns can go (an absent session is left alone).
 */
async function discardSuperseded(floors: Map<string, number>): Promise<void> {
  if (floors.size === 0) {
    return;
  }
  for (const file of await listTurnFiles()) {
    const tag = parseTurnTag(file);
    const floor = tag ? floors.get(tag.session) : undefined;
    if (tag && floor !== undefined && tag.turn < floor) {
      await removePendingRecord(file);
    }
  }
}

/**
 * Bound the spool. The SDK reports every failure the same way (null), so a turn the server will
 * never accept (revoked key, oversized body) looks just like an outage; without a cap such turns —
 * each holding the key and the turn text — would pile up forever.
 */
async function pruneSpool(): Promise<void> {
  const files = await listTurnFiles();
  const now = Date.now();
  const kept: Array<{ file: string; size: number }> = [];
  let expired = 0;
  for (const file of files) {
    try {
      const info = await fs.stat(file);
      if (now - info.mtimeMs > SPOOL_TTL_MS) {
        await removePendingRecord(file);
        expired += 1;
        continue;
      }
      kept.push({ file, size: info.size });
    } catch {
      // Vanished underneath us.
    }
  }
  // Keep the newest records that fit both caps; the oldest go first.
  let over = Math.max(0, kept.length - MAX_SPOOLED);
  let bytes = kept.slice(over).reduce((n, k) => n + k.size, 0);
  while (over < kept.length - 1 && bytes > MAX_SPOOL_BYTES) {
    bytes -= kept[over].size;
    over += 1;
  }
  for (const { file } of kept.slice(0, over)) {
    await removePendingRecord(file);
  }
  // A dropped turn is data loss; hook.log is where people are told to look (counts only, no content).
  if (expired > 0) {
    await logHookEvent(`capture-turn: dropped ${expired} spooled turn(s) 7 days after their last attempt.`);
  }
  if (over > 0) {
    await logHookEvent(`capture-turn: dropped ${over} oldest spooled turn(s) over the ${MAX_SPOOLED}-turn / ${MAX_SPOOL_BYTES >> 20} MB cap.`);
  }
}

/** Take exclusive ownership of a spooled record by renaming it out of the `*.json` listing. */
async function claim(file: string): Promise<string | null> {
  const claimed = `${file}${CLAIM_SUFFIX}`;
  try {
    // rename keeps the file's mtime, and a spooled record is usually older than STALE_CLAIM_MS. Touch it
    // BEFORE the rename so the claim is born fresh: otherwise, for an instant, it would look abandoned
    // and a concurrent run's reclaimStaleClaims could take it back. (A missing file means another run
    // already claimed it.)
    const now = new Date();
    await fs.utimes(file, now, now);
    await fs.rename(file, claimed);
    return claimed;
  } catch {
    return null; // another hook run got there first
  }
}

/** Give back claims held by a process that died mid-replay, so those turns aren't stranded. */
async function reclaimStaleClaims(): Promise<void> {
  try {
    const dir = pendingDir();
    for (const name of await fs.readdir(dir)) {
      const isClaim = name.startsWith(`${TURN_RECORD_COMMAND}-`) && name.endsWith(`.json${CLAIM_SUFFIX}`);
      // atomicWriteFile's temp file, left behind if a process died mid-write of a claimed record.
      const isTemp = name.startsWith(`.${TURN_RECORD_COMMAND}-`) && name.endsWith('.tmp');
      if (!isClaim && !isTemp) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        if (Date.now() - (await fs.stat(file)).mtimeMs > STALE_CLAIM_MS) {
          await (isClaim ? fs.rename(file, file.slice(0, -CLAIM_SUFFIX.length)) : fs.rm(file, { force: true }));
        }
      } catch {
        // Gone or being handled by someone else.
      }
    }
  } catch {
    // Housekeeping only.
  }
}

/**
 * Re-send turns spooled by earlier failures, NEWEST first: after a key rotation the old records carry
 * a dead key and fail forever, and the turns that matter are the recent ones behind them. The server
 * does not dedup, so a replay that lands twice is a duplicate log: each record is claimed atomically
 * (overlapping hook runs can't both send it) and dropped after MAX_REPLAY_ATTEMPTS failures. One
 * record the server keeps refusing doesn't block the rest; the run stops after several failures in a
 * row or once its time budget is spent. The spool is pruned first so stale records age out.
 */
export async function replaySpooledTurns(timeoutMs: number = SEND_TIMEOUT_MS): Promise<void> {
  await reclaimStaleClaims();
  await pruneSpool();
  const files = (await listTurnFiles()).reverse();
  const deadline = Date.now() + REPLAY_BUDGET_MS;
  let attempted = 0;
  let failures = 0;
  for (const file of files) {
    // Never start an upload that could outlive the budget: a hook killed mid-upload leaves a claim
    // and, if the server already took the turn, a duplicate on reclaim.
    const remaining = deadline - Date.now();
    if (attempted >= RETRY_BATCH || failures >= MAX_CONSECUTIVE_FAILURES || remaining < MIN_UPLOAD_MS) {
      return;
    }
    const uploadMs = Math.min(timeoutMs, remaining);
    const claimed = await claim(file);
    if (!claimed) {
      continue;
    }
    attempted += 1;

    let record;
    try {
      record = await readPendingRecord(claimed);
      if (!record || typeof record !== 'object') {
        throw new Error('not a record'); // e.g. the JSON literal `null`
      }
    } catch {
      await removePendingRecord(claimed); // unreadable: it can never be sent
      await logHookEvent(`capture-turn: discarded an unreadable spooled turn (${path.basename(file)}).`);
      failures += 1;
      continue;
    }

    // A hook killed mid-upload on the last allowed attempt leaves the cap reached but the record still
    // here: give up now rather than make one more (possibly duplicating) attempt.
    if ((record.attempts ?? 0) >= MAX_REPLAY_ATTEMPTS) {
      await removePendingRecord(claimed);
      await logHookEvent(`capture-turn: gave up on spooled turn ${path.basename(file)} after ${record.attempts} replay attempts.`);
      failures += 1;
      continue;
    }

    // Count the attempt BEFORE the upload: a hook killed mid-upload leaves its claim to be reclaimed,
    // and a death like that must still use up one of the record's attempts. (The server doesn't dedup,
    // so every attempt that actually landed is another duplicate log.) `record` keeps the previous
    // count, which is what the upload's replay_attempt marker is derived from.
    const attempts = (record.attempts ?? 0) + 1;
    try {
      await atomicWriteFile(claimed, `${JSON.stringify({ ...record, attempts }, null, 2)}\n`, 0o600);
    } catch {
      // Not persisted: fall through, the upload still runs.
    }

    // withTimeout turns a rejected upload into null, so this never throws.
    const uploadStarted = Date.now();
    const ok = record.kind === 'turn' && !!(await withTimeout(uploadRecord(record, { timeoutMs: uploadMs }), uploadMs));
    if (ok || attempts >= MAX_REPLAY_ATTEMPTS) {
      await removePendingRecord(claimed);
      if (ok) {
        // Delivered: older spooled turns of this session are now pointless (this one holds their text).
        const tag = parseTurnTag(file);
        if (tag) {
          await discardSuperseded(new Map([[tag.session, tag.turn]]));
        }
      }
      if (!ok) {
        await logHookEvent(`capture-turn: gave up on spooled turn ${path.basename(file)} after ${attempts} failed replays.`);
      }
      failures = ok ? 0 : failures + 1;
      continue;
    }

    failures += 1;
    // This replay ran out the clock, so the server may have stored it even if the original send was
    // refused outright: from now on the record's replays are possible duplicates.
    if (!record.ambiguous && Date.now() - uploadStarted >= uploadMs - 100) {
      try {
        await atomicWriteFile(claimed, `${JSON.stringify({ ...record, attempts, ambiguous: true }, null, 2)}\n`, 0o600);
      } catch {
        // Keep the earlier copy.
      }
    }
    await fs.rename(claimed, file).catch(() => undefined); // on failure the next reclaim hands it back
  }
}

/** This turn was DELIVERED: older spooled turns of its session no longer matter (it holds their text). */
async function discardSupersededBy(opts: SendTurnOptions): Promise<void> {
  if (opts.session && opts.turn) {
    await discardSuperseded(new Map([[sessionTag(opts.session), opts.turn]]));
  }
}

/**
 * Send one turn envelope to Coolhand with the supplied public key. On any failure (network, timeout,
 * server refusal) the turn is spooled to `~/.coolhand/pending/` carrying the key and base url, so it
 * is replayed (see {@link replaySpooledTurns}, which the caller runs after a successful send), without a login.
 * Returns `'sent'`, `'spooled'`, or `'failed'` when the send failed and the turn could not be spooled
 * either (unwritable pending dir, disk full). Throws only for an unusable `baseUrl`.
 */
export async function sendTurn(envelope: unknown, opts: SendTurnOptions): Promise<'sent' | 'spooled' | 'failed'> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  let coolhand: Coolhand;
  try {
    // The SDK validates baseUrl in its constructor (https required; http only for localhost).
    coolhand = new Coolhand({ apiKey: opts.apiKey, baseUrl, silent: true, requestTimeoutMs: timeoutMs });
  } catch (err) {
    // This message goes to hook.log: never write credentials embedded in the url (https://user:pass@host).
    const shown = baseUrl.replace(/\/\/[^/@]*@/, '//');
    throw new CliError('INVALID_BASE_URL', `Invalid base url: ${shown} (${(err as Error).message})`);
  }

  const started = Date.now();
  const result = await withTimeout(
    logTurn(coolhand, envelope, { collector: opts.collector, metadata: opts.metadata, declared: opts.declared }),
    timeoutMs
  );

  if (result === null || result === undefined) {
    // A quick failure most likely means the server did not take the turn (not a guarantee: the SDK
    // reports every failure as null). Running out the clock means we can't know, and (with no
    // server-side dedup yet) a replay of it may be a duplicate: record that.
    const ambiguous = Date.now() - started >= timeoutMs - 100;
    try {
      await savePendingRecord({
        command: TURN_RECORD_COMMAND,
        kind: 'turn',
        payload: { envelope, collector: opts.collector, metadata: opts.metadata, ...(opts.declared ? { declared: opts.declared } : {}) },
        apiKey: opts.apiKey,
        baseUrl,
        ...(ambiguous ? { ambiguous: true } : {}),
        ...(opts.session && opts.turn ? { fileTag: `${sessionTag(opts.session)}-t${opts.turn}` } : {}),
        savedAt: new Date().toISOString(),
      });
    } catch {
      return 'failed'; // the caller still advances the session's state and records the loss
    }
    // Housekeeping must not change the outcome: the turn is already safely spooled.
    await pruneSpool().catch(() => undefined);
    return 'spooled';
  }

  await discardSupersededBy(opts).catch(() => undefined);
  return 'sent';
}

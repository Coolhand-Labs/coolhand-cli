import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { configDir, atomicWriteFile } from './config.js';

/**
 * Local fallback store for records that could not be sent to Coolhand because the
 * user was not logged in. Records live under `~/.coolhand/pending/` and are uploaded
 * by the background flush on the next `coolhand login` (see `commands/flush-pending`).
 */

const PENDING_SUBDIR = 'pending';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// A dotfile so it is skipped by `listPendingFiles` (which only returns `*.json`).
const FLUSH_FAILED_MARKER = '.flush-failed';

/** What kind of SDK call the flush worker should make to upload a record. */
export type PendingKind = 'feedback' | 'turn';

export interface PendingRecord {
  /** Human-readable command name, e.g. "report-blocker". Used in the filename. */
  command: string;
  /** Selects the SDK call used to upload this record on flush. */
  kind: PendingKind;
  /** The exact payload to send (e.g. an LLMRequestLogFeedback object). */
  payload: unknown;
  /** Optional stored-client id to resolve the api key/base url at flush time. */
  clientId?: string;
  /** Public ingest key and base url supplied by a hook (no stored client). Wins over `clientId`. */
  apiKey?: string;
  baseUrl?: string;
  /** Failed replay attempts so far. Hook-spooled turns are dropped after a few: with no server-side dedup, every retry that actually landed is a duplicate log. */
  attempts?: number;
  /** ISO timestamp of when the record was saved locally. */
  savedAt: string;
}

export function pendingDir(): string {
  return path.join(configDir(), PENDING_SUBDIR);
}

async function ensurePendingDir(): Promise<string> {
  const dir = pendingDir();
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/**
 * Write a record to the pending store and return its absolute path. The filename
 * combines the command, a filesystem-safe timestamp, and random bytes so concurrent
 * saves never collide.
 */
export async function savePendingRecord(record: PendingRecord): Promise<string> {
  const dir = await ensurePendingDir();
  const safeCommand = record.command.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeStamp = record.savedAt.replace(/[:.]/g, '-');
  const fileName = `${safeCommand}-${safeStamp}-${randomBytes(4).toString('hex')}.json`;
  const filePath = path.join(dir, fileName);
  await atomicWriteFile(filePath, `${JSON.stringify(record, null, 2)}\n`, FILE_MODE);
  return filePath;
}

/**
 * `savePendingRecord` names files after `record.command`, so hook-captured turns saved with this
 * command are `capture-turn-…`. The hook owns and replays them; the user-facing flow ignores them.
 */
export const TURN_RECORD_COMMAND = 'capture-turn';
const TURN_FILE_PREFIX = `${TURN_RECORD_COMMAND}-`;

async function listRecordFiles(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(pendingDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map((name) => path.join(pendingDir(), name));
}

/**
 * Absolute paths of every saved record the user-facing flow owns (blocker feedback), oldest-first.
 * Hook-captured turns are excluded: they replay themselves and must not inflate the "you have N
 * locally-saved records" prompts shown at login or on the next command.
 */
export async function listPendingFiles(): Promise<string[]> {
  return (await listRecordFiles()).filter((file) => !path.basename(file).startsWith(TURN_FILE_PREFIX));
}

/** Absolute paths of the turns `capture-turn` spooled, oldest-first. */
export async function listTurnFiles(): Promise<string[]> {
  return (await listRecordFiles()).filter((file) => path.basename(file).startsWith(TURN_FILE_PREFIX));
}

export async function countPending(): Promise<number> {
  return (await listPendingFiles()).length;
}

export async function readPendingRecord(filePath: string): Promise<PendingRecord> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as PendingRecord;
}

export async function removePendingRecord(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

/** Set the marker that tells the next command a previous flush failed. */
export async function markFlushFailed(): Promise<void> {
  await ensurePendingDir();
  await atomicWriteFile(path.join(pendingDir(), FLUSH_FAILED_MARKER), '', FILE_MODE);
}

export async function clearFlushFailed(): Promise<void> {
  await fs.rm(path.join(pendingDir(), FLUSH_FAILED_MARKER), { force: true });
}

export async function flushFailed(): Promise<boolean> {
  try {
    await fs.access(path.join(pendingDir(), FLUSH_FAILED_MARKER));
    return true;
  } catch {
    return false;
  }
}

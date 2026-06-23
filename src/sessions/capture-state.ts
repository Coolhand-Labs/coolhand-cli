import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { configDir } from '../config.js';
import { CliError } from '../errors.js';

/**
 * Local record of how much of each Claude Code session has already been submitted, so re-running
 * `capture-sessions` does not resend a session unchanged — but DOES resend one whose transcript has
 * grown with new turns since last time.
 *
 * The server cannot deduplicate these logs itself (its dedup runs before a log is classified, and
 * matched logs are never re-checked), so the tool keeps this record and decides what to (re)send.
 * Keyed per client id, since the same session may legitimately be submitted to more than one client.
 *
 * We store a turn COUNT per session (not a yes/no flag): a chat transcript keeps growing, so a
 * boolean "already submitted?" silently drops later turns. Comparing the current turn count against
 * `turnsSubmitted` is what lets a grown session be re-submitted.
 */
export interface SubmittedSession {
  /** Number of assistant turns submitted the last time this session was sent. */
  turnsSubmitted: number;
}

export interface CaptureState {
  version: number;
  /** ISO timestamp of the last sync; used as a cheap mtime cutoff to skip unchanged files. */
  lastSyncAt?: string;
  submitted: Record<string, Record<string, SubmittedSession>>;
}

const STATE_VERSION = 2;

const STATE_FILENAME = 'capture-state.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function captureStatePath(): string {
  return path.join(configDir(), STATE_FILENAME);
}

function emptyState(): CaptureState {
  return { version: STATE_VERSION, submitted: {} };
}

/** Read a turn count defensively (hand-edited files may hold garbage). */
function toTurnCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Normalize the on-disk `submitted` map into the v2 shape, migrating v1 as we go.
 *
 * v1 stored `clientId -> sessionId[]` (a yes/no list). v2 stores
 * `clientId -> { sessionId: { turnsSubmitted } }`. Migrating a v1 entry sets `turnsSubmitted: 0`,
 * which intentionally forces a re-check of every previously-submitted session on the first v2 run —
 * so sessions that grew before this feature existed are caught.
 */
function normalizeSubmitted(raw: unknown): Record<string, Record<string, SubmittedSession>> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, Record<string, SubmittedSession>> = {};
  for (const [clientId, value] of Object.entries(raw as Record<string, unknown>)) {
    const sessions: Record<string, SubmittedSession> = {};
    if (Array.isArray(value)) {
      // v1: a plain list of session ids → migrate each to { turnsSubmitted: 0 }.
      for (const sessionId of value) {
        if (typeof sessionId === 'string') {
          sessions[sessionId] = { turnsSubmitted: 0 };
        }
      }
    } else if (value && typeof value === 'object') {
      // v2: a map of session id → { turnsSubmitted }.
      for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
        const turns = (entry as { turnsSubmitted?: unknown })?.turnsSubmitted;
        sessions[sessionId] = { turnsSubmitted: toTurnCount(turns) };
      }
    }
    out[clientId] = sessions;
  }
  return out;
}

export async function loadCaptureState(): Promise<CaptureState> {
  const filePath = captureStatePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState();
    }
    throw new CliError('CONFIG_READ_FAILED', `Failed to read ${filePath}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CaptureState> & { submitted?: unknown };
    return {
      version: STATE_VERSION,
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : undefined,
      submitted: normalizeSubmitted(parsed.submitted),
    };
  } catch (err) {
    throw new CliError(
      'CONFIG_READ_FAILED',
      `Capture state at ${filePath} is not valid JSON: ${(err as Error).message}`
    );
  }
}

/** Turns already submitted for this session/client, or 0 if it has never been submitted. */
export function getTurnsSubmitted(state: CaptureState, clientId: string, sessionId: string): number {
  return state.submitted[clientId]?.[sessionId]?.turnsSubmitted ?? 0;
}

/** Record that `turns` turns of this session have now been submitted for this client. */
export function recordSubmission(
  state: CaptureState,
  clientId: string,
  sessionId: string,
  turns: number
): void {
  const sessions = state.submitted[clientId] ?? (state.submitted[clientId] = {});
  sessions[sessionId] = { turnsSubmitted: turns };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // POSIX-only — Windows rejects chmod with this mode; ignore.
  }
}

export async function saveCaptureState(state: CaptureState): Promise<void> {
  const filePath = captureStatePath();
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  const data = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, data, { mode: FILE_MODE });
    await fs.rename(tmpPath, filePath);
    try {
      await fs.chmod(filePath, FILE_MODE);
    } catch {
      // ignore on Windows
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw new CliError('CONFIG_WRITE_FAILED', `Failed to write ${filePath}: ${(err as Error).message}`);
  }
}

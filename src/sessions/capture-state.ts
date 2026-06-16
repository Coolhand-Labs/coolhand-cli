import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { configDir } from '../config.js';
import { CliError } from '../errors.js';

/**
 * Local record of which Claude Code sessions have already been submitted, so re-running
 * `capture-sessions` does not resend (and therefore re-create) a session the server already stored.
 *
 * The server cannot deduplicate these logs itself (its dedup runs before a log is classified, and
 * matched logs are never re-checked), so the tool keeps this list and skips sessions already sent.
 * Keyed per client id, since the same session may legitimately be submitted to more than one client.
 */
export interface CaptureState {
  version: number;
  submitted: Record<string, string[]>;
}

const STATE_FILENAME = 'capture-state.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function captureStatePath(): string {
  return path.join(configDir(), STATE_FILENAME);
}

function emptyState(): CaptureState {
  return { version: 1, submitted: {} };
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
    const parsed = JSON.parse(raw) as Partial<CaptureState>;
    return {
      version: 1,
      submitted: parsed.submitted ?? {},
    };
  } catch (err) {
    throw new CliError(
      'CONFIG_READ_FAILED',
      `Capture state at ${filePath} is not valid JSON: ${(err as Error).message}`
    );
  }
}

/** True if this session id has already been submitted for this client. */
export function isSubmitted(state: CaptureState, clientId: string, sessionId: string): boolean {
  const list = state.submitted[clientId];
  return Array.isArray(list) && list.includes(sessionId);
}

/** Record a session as submitted for this client (idempotent — no duplicate ids stored). */
export function markSubmitted(state: CaptureState, clientId: string, sessionId: string): void {
  const list = state.submitted[clientId] ?? (state.submitted[clientId] = []);
  if (!list.includes(sessionId)) {
    list.push(sessionId);
  }
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

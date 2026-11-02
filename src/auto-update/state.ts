import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWriteFile, configDir } from '../config.js';
import { parseStable } from './select.js';

const STATE_FILENAME = 'update-state.json';

/** Bookkeeping for the background updater; lives next to config.json. */
export interface UpdateState {
  /** ISO time of the last registry check (success or failure) — throttles checks. */
  last_check?: string;
  /** Newest eligible version found that we did not install (not a global npm install, or the install failed). */
  available?: string;
  /** Version `available` was last announced to the user, so the notice prints once. */
  notified?: string;
  /** Version a background `npm install -g` last completed for; announced after the next launch picks it up. */
  installed?: string;
  /** Last version we tried and failed to install, with when — that version is not retried; a newer one is. */
  failed?: { version: string; at: string };
}

export function statePath(): string {
  return path.join(configDir(), STATE_FILENAME);
}

export async function loadState(): Promise<UpdateState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(), 'utf8')) as Record<string, unknown> | null;
    const raw = typeof parsed === 'object' && parsed !== null ? parsed : {};
    const state: UpdateState = {};
    for (const key of ['last_check', 'notified'] as const) {
      if (typeof raw[key] === 'string') {
        state[key] = raw[key];
      }
    }
    // Versions we act on must be plain stable semver; anything else is dropped.
    for (const key of ['available', 'installed'] as const) {
      const v = raw[key];
      if (typeof v === 'string' && parseStable(v)) {
        state[key] = v;
      }
    }
    const failed = raw.failed as Partial<NonNullable<UpdateState['failed']>> | null | undefined;
    if (typeof failed?.version === 'string' && typeof failed.at === 'string') {
      state.failed = { version: failed.version, at: failed.at };
    }
    return state;
  } catch {
    // Missing or corrupt: start fresh. The state only throttles; losing it costs one extra check.
    return {};
  }
}

export async function saveState(state: UpdateState): Promise<void> {
  const file = statePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

const LOCK_FILENAME = 'update.lock';
/** Longer than the install timeout, so a live install's lock is never taken over. */
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Exclusive lock so only one background job (and so one `npm install -g`) runs at a time. Returns a release
 * function, or null when another job holds it. A lock left by a crashed job is taken over once stale.
 */
export async function acquireLock(): Promise<(() => Promise<void>) | null> {
  const file = path.join(configDir(), LOCK_FILENAME);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await (await fs.open(file, 'wx', 0o600)).close();
        return () => fs.rm(file, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return null;
        }
        let mtimeMs: number;
        try {
          mtimeMs = (await fs.stat(file)).mtimeMs;
        } catch {
          continue; // released between open and stat: try to take it
        }
        if (Date.now() - mtimeMs < LOCK_STALE_MS) {
          return null;
        }
        await fs.rm(file, { force: true });
      }
    }
  } catch {
    // Can't lock (read-only dir, race with release): skip this run rather than risk a double install.
  }
  return null;
}

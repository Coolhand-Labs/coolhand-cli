import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { configDir, atomicWriteFile } from '../config.js';
import type { TesterIdentity } from './identity.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Per-session progress for `capture-turn`. One small file per session — deliberately NOT part of
 * the shared `capture-state.json`, which is read-modify-written without a lock and would race with
 * a hook that fires after every turn.
 */
export interface TurnState {
  /** Turns already sent for this session; the next turn gets this + 1. */
  turnIndex: number;
  /** Digest of the last turn sent, so a hook that fires twice for one turn sends it once. */
  lastDigest?: string;
  /** Who this session is attributed to, resolved on its first turn so git isn't consulted every turn. */
  tester?: TesterIdentity;
}

const TESTER_SOURCES: readonly TesterIdentity['source'][] = ['env', 'git', 'machine'];

export function turnsDir(): string {
  return path.join(configDir(), 'capture-turns');
}

function statePath(agent: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  // The hash keeps two ids that sanitise to the same string apart.
  const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 8);
  return path.join(turnsDir(), `${agent}-${safe}-${hash}.json`);
}

export async function loadTurnState(agent: string, sessionId: string): Promise<TurnState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(agent, sessionId), 'utf8')) as Partial<TurnState>;
    return {
      turnIndex: typeof parsed.turnIndex === 'number' && parsed.turnIndex >= 0 ? Math.floor(parsed.turnIndex) : 0,
      lastDigest: typeof parsed.lastDigest === 'string' ? parsed.lastDigest : undefined,
      tester:
        parsed.tester &&
        typeof parsed.tester.id === 'string' &&
        (TESTER_SOURCES as readonly unknown[]).includes(parsed.tester.source)
          ? parsed.tester
          : undefined,
    };
  } catch {
    return { turnIndex: 0 };
  }
}

export async function saveTurnState(agent: string, sessionId: string, state: TurnState): Promise<void> {
  await fs.mkdir(turnsDir(), { recursive: true, mode: DIR_MODE });
  await atomicWriteFile(statePath(agent, sessionId), `${JSON.stringify(state)}\n`, FILE_MODE);
  if (state.turnIndex === 1) {
    // A session's first turn is the cheap, once-per-session moment to clear out stale sessions.
    await pruneOldState();
  }
}

/** Identity of a turn: its text plus, when known, the agent's own id for it. */
export function digestTurn(userText: string | undefined, assistantText: string, turnKey?: string): string {
  return createHash('sha256')
    .update(userText ?? '')
    .update('\0')
    .update(assistantText)
    .update('\0')
    .update(turnKey ?? '')
    .digest('hex');
}

const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Delete per-session state files untouched for 30 days. Best-effort; never throws. */
async function pruneOldState(): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(turnsDir());
  } catch {
    return; // Housekeeping only.
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const file = path.join(turnsDir(), name);
    try {
      // Per file: another session's hook may remove one between the readdir and here.
      if (now - (await fs.stat(file)).mtimeMs > STATE_TTL_MS) {
        await fs.rm(file, { force: true });
      }
    } catch {
      // Gone already.
    }
  }
}

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
  /**
   * When the session's first captured turn was written (ISO 8601). History sent with later turns
   * starts here, so nothing said before the skill was invoked is uploaded.
   */
  anchor?: string;
  /**
   * Timestamps of the exchanges a hook actually captured, newest last (bounded). History sent with a
   * later turn is limited to these: what the user typed while capture was off (a resumed session, the
   * kill switch, no key, a killed hook) is never swept up into a later upload.
   */
  captured?: string[];
  /** The anchor was seeded after turn 1, so the start of the conversation was never sent (always flagged). */
  anchorLate?: boolean;
  /**
   * The skill's text (the body Claude Code injected when it was invoked), kept once found so every
   * later turn can send it without the invocation still being inside the transcript window.
   */
  skillText?: string;
  /** The skill a `--skill` pattern resolved to on the session's first captured turn; later turns stay on it. */
  skill?: string;
  /**
   * The prompt an agent reported before its reply (Cursor's `beforeSubmitPrompt`), waiting to be
   * paired with that reply. A missing one just means no user half.
   */
  pendingPrompt?: string;
  /** Cursor's id for the user message `pendingPrompt` belongs to, so only that message's reply consumes it. */
  pendingGeneration?: string;
}

const MAX_CAPTURED_STAMPS = 1000;

/** `captured` with one more exchange recorded (de-duplicated, bounded to the newest MAX_CAPTURED_STAMPS). */
export function withCaptured(captured: readonly string[] | undefined, stamp: string | undefined): string[] {
  const all = captured ?? [];
  if (!stamp || all.includes(stamp)) {
    return [...all];
  }
  return [...all, stamp].slice(-MAX_CAPTURED_STAMPS);
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
      anchor: typeof parsed.anchor === 'string' && !Number.isNaN(Date.parse(parsed.anchor)) ? parsed.anchor : undefined,
      captured: Array.isArray(parsed.captured) ? parsed.captured.filter((x): x is string => typeof x === 'string').slice(-MAX_CAPTURED_STAMPS) : undefined,
      anchorLate: parsed.anchorLate === true ? true : undefined,
      skillText: typeof parsed.skillText === 'string' && parsed.skillText ? parsed.skillText : undefined,
      pendingPrompt: typeof parsed.pendingPrompt === 'string' && parsed.pendingPrompt ? parsed.pendingPrompt : undefined,
      pendingGeneration: typeof parsed.pendingGeneration === 'string' && parsed.pendingGeneration ? parsed.pendingGeneration : undefined,
      skill: typeof parsed.skill === 'string' && parsed.skill ? parsed.skill.slice(0, 200) : undefined,
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
const TEMP_TTL_MS = 60 * 60 * 1000;

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
    // State files age out after 30 days; an `atomicWriteFile` temp file (left by a hook killed
    // mid-write) is stale after an hour.
    const isState = name.endsWith('.json');
    const isTemp = name.startsWith('.') && name.endsWith('.tmp');
    if (!isState && !isTemp) {
      continue;
    }
    const file = path.join(turnsDir(), name);
    try {
      // Per file: another session's hook may remove one between the readdir and here.
      if (now - (await fs.stat(file)).mtimeMs > (isState ? STATE_TTL_MS : TEMP_TTL_MS)) {
        await fs.rm(file, { force: true });
      }
    } catch {
      // Gone already.
    }
  }
}

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  loadCaptureState,
  saveCaptureState,
  captureStatePath,
  getTurnsSubmitted,
  recordSubmission,
  V1_MIGRATION_SENTINEL,
  type CaptureState,
} from '../../src/sessions/capture-state.js';

describe('capture-state (pure helpers)', () => {
  function empty(): CaptureState {
    return { version: 2, submitted: {} };
  }

  test('a fresh session reports 0 turns submitted', () => {
    expect(getTurnsSubmitted(empty(), 'client-1', 'sess-a')).toBe(0);
  });

  test('recordSubmission stores the turn count, getTurnsSubmitted reads it back', () => {
    const state = empty();
    recordSubmission(state, 'client-1', 'sess-a', 3);
    expect(getTurnsSubmitted(state, 'client-1', 'sess-a')).toBe(3);
  });

  test('recordSubmission overwrites a prior count (a grown session)', () => {
    const state = empty();
    recordSubmission(state, 'client-1', 'sess-a', 3);
    recordSubmission(state, 'client-1', 'sess-a', 7);
    expect(getTurnsSubmitted(state, 'client-1', 'sess-a')).toBe(7);
    expect(state.submitted['client-1']).toEqual({ 'sess-a': { turnsSubmitted: 7 } });
  });

  test('keeps clients separate', () => {
    const state = empty();
    recordSubmission(state, 'client-1', 'sess-a', 2);
    expect(getTurnsSubmitted(state, 'client-2', 'sess-a')).toBe(0);
  });
});

describe('capture-state (persistence)', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `chs-state-${randomBytes(6).toString('hex')}`);
    prev = process.env.COOLHAND_CONFIG_DIR;
    process.env.COOLHAND_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (prev === undefined) {
      delete process.env.COOLHAND_CONFIG_DIR;
    } else {
      process.env.COOLHAND_CONFIG_DIR = prev;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('returns an empty v2 state when no file exists yet', async () => {
    const state = await loadCaptureState();
    expect(state).toEqual({ version: 2, submitted: {} });
  });

  test('round-trips submitted turn counts through save and load', async () => {
    const state = await loadCaptureState();
    recordSubmission(state, 'client-1', 'sess-a', 4);
    recordSubmission(state, 'client-1', 'sess-b', 1);
    await saveCaptureState(state);

    const reloaded = await loadCaptureState();
    expect(reloaded.version).toBe(2);
    expect(getTurnsSubmitted(reloaded, 'client-1', 'sess-a')).toBe(4);
    expect(getTurnsSubmitted(reloaded, 'client-1', 'sess-b')).toBe(1);
    expect(getTurnsSubmitted(reloaded, 'client-1', 'sess-c')).toBe(0);
  });

  test('persists lastSyncAt', async () => {
    const state = await loadCaptureState();
    state.lastSyncAt = '2026-06-10T14:23:00.000Z';
    await saveCaptureState(state);

    const reloaded = await loadCaptureState();
    expect(reloaded.lastSyncAt).toBe('2026-06-10T14:23:00.000Z');
  });

  test('migrates a v1 file: every old session id becomes the migration sentinel', async () => {
    // Write an old-format (v1) file directly to disk.
    await fs.mkdir(dir, { recursive: true });
    const v1 = { version: 1, submitted: { 'client-1': ['sess-a', 'sess-b'] } };
    await fs.writeFile(captureStatePath(), `${JSON.stringify(v1, null, 2)}\n`);

    const state = await loadCaptureState();
    expect(state.version).toBe(2);
    // Sentinel (-1) means "submitted under v1, turn count unknown". run() will record the real
    // count on the next scan without re-submitting, preventing duplicate uploads on first upgrade.
    expect(getTurnsSubmitted(state, 'client-1', 'sess-a')).toBe(V1_MIGRATION_SENTINEL);
    expect(getTurnsSubmitted(state, 'client-1', 'sess-b')).toBe(V1_MIGRATION_SENTINEL);
    expect(state.submitted['client-1']).toEqual({
      'sess-a': { turnsSubmitted: V1_MIGRATION_SENTINEL },
      'sess-b': { turnsSubmitted: V1_MIGRATION_SENTINEL },
    });
  });

  test('a migrated v1 file is rewritten as v2 on next save', async () => {
    await fs.mkdir(dir, { recursive: true });
    const v1 = { version: 1, submitted: { 'client-1': ['sess-a'] } };
    await fs.writeFile(captureStatePath(), `${JSON.stringify(v1, null, 2)}\n`);

    const state = await loadCaptureState();
    recordSubmission(state, 'client-1', 'sess-a', 5);
    await saveCaptureState(state);

    const raw = JSON.parse(await fs.readFile(captureStatePath(), 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.submitted['client-1']['sess-a']).toEqual({ turnsSubmitted: 5 });
  });
});

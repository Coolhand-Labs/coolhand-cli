import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  loadCaptureState,
  saveCaptureState,
  isSubmitted,
  markSubmitted,
  type CaptureState,
} from '../../src/sessions/capture-state.js';

describe('capture-state (pure helpers)', () => {
  function empty(): CaptureState {
    return { version: 1, submitted: {} };
  }

  test('a fresh session is not yet submitted', () => {
    expect(isSubmitted(empty(), 'client-1', 'sess-a')).toBe(false);
  });

  test('markSubmitted records a session, isSubmitted then reports it', () => {
    const state = empty();
    markSubmitted(state, 'client-1', 'sess-a');
    expect(isSubmitted(state, 'client-1', 'sess-a')).toBe(true);
  });

  test('markSubmitted is idempotent (no duplicate ids stored)', () => {
    const state = empty();
    markSubmitted(state, 'client-1', 'sess-a');
    markSubmitted(state, 'client-1', 'sess-a');
    expect(state.submitted['client-1']).toEqual(['sess-a']);
  });

  test('keeps clients separate', () => {
    const state = empty();
    markSubmitted(state, 'client-1', 'sess-a');
    expect(isSubmitted(state, 'client-2', 'sess-a')).toBe(false);
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

  test('returns an empty state when no file exists yet', async () => {
    const state = await loadCaptureState();
    expect(state).toEqual({ version: 1, submitted: {} });
  });

  test('round-trips submitted sessions through save and load', async () => {
    const state = await loadCaptureState();
    markSubmitted(state, 'client-1', 'sess-a');
    markSubmitted(state, 'client-1', 'sess-b');
    await saveCaptureState(state);

    const reloaded = await loadCaptureState();
    expect(isSubmitted(reloaded, 'client-1', 'sess-a')).toBe(true);
    expect(isSubmitted(reloaded, 'client-1', 'sess-b')).toBe(true);
    expect(isSubmitted(reloaded, 'client-1', 'sess-c')).toBe(false);
  });
});

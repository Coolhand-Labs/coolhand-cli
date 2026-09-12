import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  loadSkillState,
  saveSkillState,
  skillStatePath,
  getUploadRecord,
  recordUpload,
  type SkillState,
} from '../../src/skills/skill-state.js';

describe('skill-state (pure helpers)', () => {
  function empty(): SkillState {
    return { version: 1, uploaded: {} };
  }

  test('a never-uploaded skill has no record', () => {
    expect(getUploadRecord(empty(), 'client-1', 'my-skill', 'h1')).toBeUndefined();
  });

  test('recordUpload stores the record, getUploadRecord reads it back', () => {
    const state = empty();
    recordUpload(state, 'client-1', 'my-skill', 'h1', { contentHash: 'h1', uploadedAt: '2026-01-01T00:00:00.000Z' });
    expect(getUploadRecord(state, 'client-1', 'my-skill', 'h1')).toEqual({
      contentHash: 'h1',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('a record for a different contentHash under the same skillName is not a match', () => {
    const state = empty();
    recordUpload(state, 'client-1', 'my-skill', 'h1', { contentHash: 'h1', uploadedAt: '2026-01-01T00:00:00.000Z' });
    expect(getUploadRecord(state, 'client-1', 'my-skill', 'h2')).toBeUndefined();
  });

  test('recordUpload for a new contentHash does not clobber a prior record for the same skillName', () => {
    // Regression test: dedupeSkillFiles can legitimately produce two candidates with the same
    // skillName but different contentHash (e.g. a just-edited authored copy alongside a stale
    // installed duplicate of the pre-edit content). Both must be independently trackable, or
    // whichever one isn't the last one recorded gets endlessly re-uploaded on every later run.
    const state = empty();
    recordUpload(state, 'client-1', 'my-skill', 'h-old', { contentHash: 'h-old', uploadedAt: '2026-01-01T00:00:00.000Z' });
    recordUpload(state, 'client-1', 'my-skill', 'h-new', { contentHash: 'h-new', uploadedAt: '2026-02-01T00:00:00.000Z' });

    expect(getUploadRecord(state, 'client-1', 'my-skill', 'h-old')?.uploadedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(getUploadRecord(state, 'client-1', 'my-skill', 'h-new')?.uploadedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  test('keeps clients separate', () => {
    const state = empty();
    recordUpload(state, 'client-1', 'my-skill', 'h1', { contentHash: 'h1', uploadedAt: '2026-01-01T00:00:00.000Z' });
    expect(getUploadRecord(state, 'client-2', 'my-skill', 'h1')).toBeUndefined();
  });
});

describe('skill-state (persistence)', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `skill-state-${randomBytes(6).toString('hex')}`);
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
    const state = await loadSkillState();
    expect(state).toEqual({ version: 1, uploaded: {} });
  });

  test('round-trips upload records through save and load', async () => {
    const state = await loadSkillState();
    recordUpload(state, 'client-1', 'skill-a', 'h1', { contentHash: 'h1', uploadedAt: '2026-01-01T00:00:00.000Z', clientFileId: 'cf_1' });
    await saveSkillState(state);

    const reloaded = await loadSkillState();
    expect(getUploadRecord(reloaded, 'client-1', 'skill-a', 'h1')).toEqual({
      contentHash: 'h1',
      uploadedAt: '2026-01-01T00:00:00.000Z',
      clientFileId: 'cf_1',
    });
  });

  test('writes the state file with 0o600 permissions', async () => {
    const state = await loadSkillState();
    recordUpload(state, 'client-1', 'skill-a', 'h1', { contentHash: 'h1', uploadedAt: '2026-01-01T00:00:00.000Z' });
    await saveSkillState(state);

    const stat = await fs.stat(skillStatePath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('ignores a malformed on-disk entry rather than crashing', async () => {
    await fs.mkdir(dir, { recursive: true });
    const malformed = { version: 1, uploaded: { 'client-1': { '["skill-a","h1"]': { contentHash: 42 } } } };
    await fs.writeFile(skillStatePath(), `${JSON.stringify(malformed, null, 2)}\n`);

    const state = await loadSkillState();
    expect(getUploadRecord(state, 'client-1', 'skill-a', 'h1')).toBeUndefined();
  });

  test('throws CONFIG_READ_FAILED on invalid JSON', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(skillStatePath(), 'not json');
    await expect(loadSkillState()).rejects.toThrow(/not valid JSON/);
  });
});

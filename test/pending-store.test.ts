import { promises as fs } from 'fs';
import * as path from 'path';
import {
  savePendingRecord,
  listPendingFiles,
  countPending,
  readPendingRecord,
  removePendingRecord,
  pendingDir,
  markFlushFailed,
  clearFlushFailed,
  flushFailed,
  type PendingRecord,
} from '../src/pending-store.js';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';

function makeRecord(overrides: Partial<PendingRecord> = {}): PendingRecord {
  return {
    command: 'report-blocker',
    kind: 'feedback',
    payload: { explanation: 'no internet', creator_type: 'agent' },
    savedAt: '2026-06-29T12:00:00.000Z',
    ...overrides,
  };
}

describe('pending-store', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('countPending and listPendingFiles return empty when nothing saved', async () => {
    expect(await countPending()).toBe(0);
    expect(await listPendingFiles()).toEqual([]);
  });

  test('savePendingRecord writes a readable record and returns its path', async () => {
    const filePath = await savePendingRecord(makeRecord());
    expect(filePath.startsWith(pendingDir())).toBe(true);
    expect(filePath.endsWith('.json')).toBe(true);

    const record = await readPendingRecord(filePath);
    expect(record.command).toBe('report-blocker');
    expect(record.kind).toBe('feedback');
    expect((record.payload as { explanation: string }).explanation).toBe('no internet');
  });

  test('saved file is owner-only (0o600) on POSIX', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const filePath = await savePendingRecord(makeRecord());
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('countPending reflects multiple saves', async () => {
    await savePendingRecord(makeRecord());
    await savePendingRecord(makeRecord());
    await savePendingRecord(makeRecord());
    expect(await countPending()).toBe(3);
    expect(await listPendingFiles()).toHaveLength(3);
  });

  test('removePendingRecord deletes a single record', async () => {
    const filePath = await savePendingRecord(makeRecord());
    await savePendingRecord(makeRecord());
    await removePendingRecord(filePath);
    expect(await countPending()).toBe(1);
  });

  test('listPendingFiles ignores dotfiles and non-json files', async () => {
    await savePendingRecord(makeRecord());
    await markFlushFailed(); // writes a .flush-failed dotfile
    await fs.writeFile(path.join(pendingDir(), 'notes.txt'), 'ignore me');
    const files = await listPendingFiles();
    expect(files).toHaveLength(1);
    expect(files[0].endsWith('.json')).toBe(true);
  });

  test('flush-failed marker can be set, read, and cleared', async () => {
    expect(await flushFailed()).toBe(false);
    await markFlushFailed();
    expect(await flushFailed()).toBe(true);
    await clearFlushFailed();
    expect(await flushFailed()).toBe(false);
  });

  test('clearFlushFailed is idempotent when no marker exists', async () => {
    await expect(clearFlushFailed()).resolves.toBeUndefined();
  });
});

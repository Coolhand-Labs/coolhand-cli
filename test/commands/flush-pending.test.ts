const createFeedbackMock = jest.fn().mockResolvedValue({ id: 1 });

jest.mock('coolhand-node', () => ({
  Coolhand: jest.fn().mockImplementation(() => ({
    createFeedback: createFeedbackMock,
  })),
}));

import { flushPending, spawnBackgroundFlush } from '../../src/commands/flush-pending.js';
import { upsertClient } from '../../src/config.js';
import {
  savePendingRecord,
  countPending,
  flushFailed,
  type PendingRecord,
} from '../../src/pending-store.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

function makeRecord(): PendingRecord {
  return {
    command: 'report-blocker',
    kind: 'feedback',
    payload: { explanation: 'blocked', creator_type: 'agent', creator_unique_id: 'agent-1' },
    savedAt: '2026-06-29T12:00:00.000Z',
  };
}

describe('flush-pending', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
    createFeedbackMock.mockReset().mockResolvedValue({ id: 1 });
    await upsertClient(
      {
        client_id: 'acme',
        client_name: 'Acme',
        api_key: 'pub_key',
        base_url: 'https://coolhandlabs.com',
        saved_at: 'now',
      },
      true
    );
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('uploads each record, deletes on success, clears the failed marker', async () => {
    await savePendingRecord(makeRecord());
    await savePendingRecord(makeRecord());

    const result = await flushPending();

    expect(result).toEqual({ uploaded: 2, failed: 0 });
    expect(createFeedbackMock).toHaveBeenCalledTimes(2);
    expect(await countPending()).toBe(0);
    expect(await flushFailed()).toBe(false);
  });

  test('keeps the file and sets the failed marker when the server does not confirm', async () => {
    createFeedbackMock.mockResolvedValue(null);
    await savePendingRecord(makeRecord());

    const result = await flushPending();

    expect(result).toEqual({ uploaded: 0, failed: 1 });
    expect(await countPending()).toBe(1);
    expect(await flushFailed()).toBe(true);
  });

  test('a mix of success and failure keeps only the failed records', async () => {
    createFeedbackMock
      .mockResolvedValueOnce({ id: 1 }) // first uploads
      .mockResolvedValueOnce(null); // second fails
    await savePendingRecord(makeRecord());
    await savePendingRecord(makeRecord());

    const result = await flushPending();

    expect(result).toEqual({ uploaded: 1, failed: 1 });
    expect(await countPending()).toBe(1);
    expect(await flushFailed()).toBe(true);
  });

  test('flushPending on an empty store clears the marker and uploads nothing', async () => {
    const result = await flushPending();
    expect(result).toEqual({ uploaded: 0, failed: 0 });
    expect(createFeedbackMock).not.toHaveBeenCalled();
  });

  test('spawnBackgroundFlush launches a detached, unref-ed __flush-pending process', () => {
    const onMock = jest.fn();
    const unrefMock = jest.fn();
    const spawnFn = jest.fn().mockReturnValue({ on: onMock, unref: unrefMock });
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/path/to/dist/bin.js';

    try {
      spawnBackgroundFlush({ spawnFn: spawnFn as unknown as typeof import('child_process').spawn });
    } finally {
      process.argv[1] = originalArgv1;
    }

    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      ['/path/to/dist/bin.js', '__flush-pending'],
      { detached: true, stdio: 'ignore' }
    );
    expect(unrefMock).toHaveBeenCalled();
  });
});

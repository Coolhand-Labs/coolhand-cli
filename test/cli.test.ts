jest.mock('../src/commands/flush-pending.js', () => ({
  run: jest.fn().mockResolvedValue(0),
  spawnBackgroundFlush: jest.fn(),
}));
jest.mock('../src/prompt.js', () => ({ confirm: jest.fn().mockResolvedValue(false) }));

import { parseArgs, run } from '../src/cli.js';
import { run as runFlushPending, spawnBackgroundFlush } from '../src/commands/flush-pending.js';
import { confirm } from '../src/prompt.js';
import { markFlushFailed, savePendingRecord } from '../src/pending-store.js';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';

function makePending() {
  return savePendingRecord({
    command: 'report-blocker',
    kind: 'feedback' as const,
    payload: { explanation: 'x', creator_type: 'agent' as const },
    savedAt: '2026-06-29T12:00:00.000Z',
  });
}

describe('parseArgs', () => {
  test('extracts subcommand and flags', () => {
    const parsed = parseArgs(['login', '--base-url', 'https://x', '--json']);
    expect(parsed.command).toBe('login');
    expect(parsed.flags['base-url']).toBe('https://x');
    expect(parsed.flags.json).toBe(true);
  });

  test('supports = syntax', () => {
    const parsed = parseArgs(['login', '--base-url=https://x']);
    expect(parsed.flags['base-url']).toBe('https://x');
  });

  test('captures positional arguments', () => {
    const parsed = parseArgs(['clients', 'use', 'acme']);
    expect(parsed.command).toBe('clients');
    expect(parsed.positional).toEqual(['use', 'acme']);
  });

  test('treats short flag as boolean', () => {
    const parsed = parseArgs(['--version']);
    expect(parsed.flags.version).toBe(true);
  });

  test('does not consume positional id after boolean flag', () => {
    const parsed = parseArgs(['get-optimization', '--json', 'opt-1']);
    expect(parsed.command).toBe('get-optimization');
    expect(parsed.flags.json).toBe(true);
    expect(parsed.positional).toEqual(['opt-1']);
  });

  test('preserves multi-word positional text', () => {
    const parsed = parseArgs(['close-optimization', 'opt-1', 'looks', 'good']);
    expect(parsed.command).toBe('close-optimization');
    expect(parsed.positional).toEqual(['opt-1', 'looks', 'good']);
  });
});

describe('run', () => {
  let home: TmpHome;
  beforeEach(async () => {
    home = await createTmpHome();
    (runFlushPending as jest.Mock).mockClear().mockResolvedValue(0);
    (spawnBackgroundFlush as jest.Mock).mockClear();
    (confirm as jest.Mock).mockReset().mockResolvedValue(false);
  });
  afterEach(async () => {
    await home.cleanup();
  });

  test('--version exits 0', async () => {
    const code = await run(['--version']);
    expect(code).toBe(0);
  });

  test('unknown command exits with USER_ERROR', async () => {
    const code = await run(['frobnicate']);
    expect(code).toBe(1);
  });

  test('status with no config exits 1', async () => {
    const code = await run(['status', '--json']);
    expect(code).toBe(1);
  });

  test('help exits 0', async () => {
    const code = await run(['help']);
    expect(code).toBe(0);
  });

  test('login --write-env without path returns INVALID_ARGS', async () => {
    const code = await run(['login', '--write-env']);
    expect(code).toBe(1);
  });

  test('get-optimization without id returns exit 1', async () => {
    const code = await run(['get-optimization']);
    expect(code).toBe(1);
  });

  test('close-optimization without id returns exit 1', async () => {
    const code = await run(['close-optimization']);
    expect(code).toBe(1);
  });

  test('close-optimization with id but no reason returns exit 1', async () => {
    const code = await run(['close-optimization', 'abc-123']);
    expect(code).toBe(1);
  });

  test('update-optimization without id returns exit 1', async () => {
    const code = await run(['update-optimization']);
    expect(code).toBe(1);
  });

  test('hidden __flush-pending command dispatches to the flush worker', async () => {
    const code = await run(['__flush-pending']);
    expect(code).toBe(0);
    expect(runFlushPending).toHaveBeenCalled();
  });

  test('failed-flush reminder offers retry and launches background flush on yes', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['status']);

    expect(confirm).toHaveBeenCalled();
    expect(spawnBackgroundFlush).toHaveBeenCalled();
  });

  test('failed-flush reminder does not launch flush when the user declines', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(false);

    await run(['status']);

    expect(confirm).toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('no failed-flush reminder when there was no prior failure', async () => {
    await makePending(); // records exist, but no failed marker
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['status']);

    expect(confirm).not.toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('failed-flush reminder is skipped in --json mode', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['status', '--json']);

    expect(confirm).not.toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

});

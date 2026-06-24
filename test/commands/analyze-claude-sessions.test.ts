import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { run } from '../../src/commands/analyze-claude-sessions.js';

jest.mock('../../src/sessions/claude-scanner.js', () => {
  const actual = jest.requireActual('../../src/sessions/claude-scanner.js');
  return { ...actual, scanSessions: jest.fn() };
});
jest.mock('../../src/log-request.js', () => ({
  logRequest: jest.fn(),
}));
jest.mock('../../src/api/last-sync.js', () => ({
  fetchLastSync: jest.fn(),
}));
import { scanSessions } from '../../src/sessions/claude-scanner.js';
import { logRequest } from '../../src/log-request.js';
import { fetchLastSync } from '../../src/api/last-sync.js';

const envelope = {
  url: 'claudecode://session/s',
  method: 'POST',
  status_code: 200,
  request_body: { messages: [{ role: 'user', content: 'hi' }] },
  response_body: { id: 'r', type: 'message', role: 'assistant', content: [] },
  turnCount: 1,
};

describe('analyze-claude-sessions command', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    // Isolate the config/state directory so each test starts with a clean submitted record.
    dir = path.join(os.tmpdir(), `chs-cmd-${randomBytes(6).toString('hex')}`);
    prev = process.env.COOLHAND_CONFIG_DIR;
    process.env.COOLHAND_CONFIG_DIR = dir;
    (scanSessions as jest.Mock).mockReset().mockResolvedValue({ envelopes: [envelope], sessionCount: 1 });
    (logRequest as jest.Mock).mockReset().mockResolvedValue({ id: 1 });
    (fetchLastSync as jest.Mock).mockReset().mockResolvedValue(null);
  });

  afterEach(async () => {
    if (prev === undefined) {
      delete process.env.COOLHAND_CONFIG_DIR;
    } else {
      process.env.COOLHAND_CONFIG_DIR = prev;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('submits each session and returns 0', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(logRequest).toHaveBeenCalledTimes(1);
    expect(logRequest).toHaveBeenCalledWith(envelope, { clientId: undefined });
  });

  test('dry-run sends nothing and returns 0', async () => {
    const code = await run({ dryRun: true });
    expect(code).toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });

  test('forwards --client-id to logRequest', async () => {
    await run({ clientId: 'c1' });
    expect(logRequest).toHaveBeenCalledWith(envelope, { clientId: 'c1' });
  });

  test('does not re-submit an unchanged session on a later run', async () => {
    const first = await run({});
    expect(first).toBe(0);
    expect(logRequest).toHaveBeenCalledTimes(1);

    (logRequest as jest.Mock).mockClear();
    // Same session, same turn count → unchanged → not re-submitted.
    const second = await run({});
    expect(second).toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });

  test('re-submits a session whose transcript grew (the core fix)', async () => {
    const first = await run({});
    expect(first).toBe(0);
    expect(logRequest).toHaveBeenCalledTimes(1);

    (logRequest as jest.Mock).mockClear();
    // Same session id, but now 3 turns instead of 1 → updated → re-submitted.
    (scanSessions as jest.Mock).mockResolvedValue({
      envelopes: [{ ...envelope, turnCount: 3 }],
      sessionCount: 1,
    });
    const second = await run({});
    expect(second).toBe(0);
    expect(logRequest).toHaveBeenCalledTimes(1);
  });

  test('forwards the server last-sync time to scanSessions as sinceTime', async () => {
    const serverTime = new Date('2026-06-10T14:23:00.000Z');
    (fetchLastSync as jest.Mock).mockResolvedValue(serverTime);
    await run({});
    expect(scanSessions).toHaveBeenCalledWith({ sinceTime: serverTime });
  });

  test('falls back to epoch when no server time and no local state', async () => {
    await run({});
    expect(scanSessions).toHaveBeenCalledWith({ sinceTime: new Date(0) });
  });

  test('dry-run does not record anything', async () => {
    await run({ dryRun: true });
    // A real run afterward should still submit, proving the dry-run recorded nothing.
    const code = await run({});
    expect(code).toBe(0);
    expect(logRequest).toHaveBeenCalledTimes(1);
  });

  test('returns non-zero when a session fails to submit', async () => {
    const { CliError } = await import('../../src/errors.js');
    (logRequest as jest.Mock).mockRejectedValueOnce(new CliError('INGEST_ERROR', 'boom'));
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('does NOT advance lastSyncAt when a submission fails (failed-but-grown sessions stay catchable)', async () => {
    const { CliError } = await import('../../src/errors.js');
    (logRequest as jest.Mock).mockRejectedValueOnce(new CliError('INGEST_ERROR', 'boom'));
    await run({});
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'capture-state.json'), 'utf8'));
    expect(raw.lastSyncAt).toBeUndefined();
  });

  test('advances lastSyncAt after a fully successful run', async () => {
    await run({});
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'capture-state.json'), 'utf8'));
    expect(typeof raw.lastSyncAt).toBe('string');
  });

  test('aborts immediately on a fatal config error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (scanSessions as jest.Mock).mockResolvedValue({
      envelopes: [envelope, { ...envelope, url: 'claudecode://session/s2' }],
      sessionCount: 2,
    });
    (logRequest as jest.Mock).mockRejectedValue(new CliError('NOT_CONFIGURED', 'login first'));
    const code = await run({});
    expect(code).toBe(1);
    expect(logRequest).toHaveBeenCalledTimes(1);
  });

  test('--json exits 0 on success', async () => {
    const code = await run({ json: true });
    expect(code).toBe(0);
  });

  test('returns 0 with zero sessions', async () => {
    (scanSessions as jest.Mock).mockResolvedValue({ envelopes: [], sessionCount: 0 });
    const code = await run({});
    expect(code).toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });
});

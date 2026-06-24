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
import { scanSessions } from '../../src/sessions/claude-scanner.js';
import { logRequest } from '../../src/log-request.js';

const envelope = {
  url: 'claudecode://session/s',
  method: 'POST',
  status_code: 200,
  request_body: { messages: [{ role: 'user', content: 'hi' }] },
  response_body: { id: 'r', type: 'message', role: 'assistant', content: [] },
};

describe('analyze-claude-sessions command', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    // Isolate the config/state directory so each test starts with a clean "already submitted" list.
    dir = path.join(os.tmpdir(), `chs-cmd-${randomBytes(6).toString('hex')}`);
    prev = process.env.COOLHAND_CONFIG_DIR;
    process.env.COOLHAND_CONFIG_DIR = dir;
    (scanSessions as jest.Mock).mockReset().mockResolvedValue({ envelopes: [envelope], sessionCount: 1 });
    (logRequest as jest.Mock).mockReset().mockResolvedValue({ id: 1 });
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

  test('skips a session that was already submitted on a previous run', async () => {
    const first = await run({});
    expect(first).toBe(0);
    expect(logRequest).toHaveBeenCalledTimes(1);

    (logRequest as jest.Mock).mockClear();
    const second = await run({});
    expect(second).toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
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

import { run } from '../../src/commands/capture-sessions.js';

jest.mock('../../src/sessions/claude-scanner.js', () => ({
  scanSessions: jest.fn(),
}));
jest.mock('../../src/log-request.js', () => ({
  logRequest: jest.fn(),
}));
import { scanSessions } from '../../src/sessions/claude-scanner.js';
import { logRequest } from '../../src/log-request.js';

const envelope = {
  url: 'claudecode://session/s/r',
  method: 'POST',
  status_code: 200,
  request_body: { messages: [{ role: 'user', content: 'hi' }] },
  response_body: { id: 'r', type: 'message', role: 'assistant', content: [] },
};

describe('capture-sessions command', () => {
  beforeEach(() => {
    (scanSessions as jest.Mock).mockReset().mockResolvedValue({ envelopes: [envelope], sessionCount: 1 });
    (logRequest as jest.Mock).mockReset().mockResolvedValue({ id: 1 });
  });

  test('submits each envelope and returns 0', async () => {
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

  test('returns non-zero when a turn fails to submit', async () => {
    const { CliError } = await import('../../src/errors.js');
    (logRequest as jest.Mock).mockRejectedValueOnce(new CliError('INGEST_ERROR', 'boom'));
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('aborts immediately on a fatal config error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (scanSessions as jest.Mock).mockResolvedValue({ envelopes: [envelope, envelope], sessionCount: 1 });
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

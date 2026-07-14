import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { run } from '../../src/commands/analyze-claude-sessions.js';

jest.mock('../../src/config.js', () => {
  const actual = jest.requireActual('../../src/config.js');
  return {
    ...actual,
    loadConfig: jest.fn().mockResolvedValue({ version: 1, clients: {}, default_client_id: null }),
    resolveClient: jest.fn().mockImplementation((_cfg: unknown, clientId?: string) =>
      Promise.resolve({
        client_id: clientId ?? 'default-client',
        client_name: 'Test Client',
        api_key: 'key',
        base_url: 'https://coolhandlabs.com',
        saved_at: 'now',
      })
    ),
  };
});
jest.mock('../../src/sessions/claude-scanner.js', () => {
  const actual = jest.requireActual('../../src/sessions/claude-scanner.js');
  return { ...actual, scanSessions: jest.fn() };
});
jest.mock('../../src/sessions/cowork-scanner.js', () => ({
  scanCoworkSessions: jest.fn(),
}));
jest.mock('../../src/log-request.js', () => ({
  logRequest: jest.fn(),
}));
jest.mock('../../src/api/last-sync.js', () => ({
  fetchLastSync: jest.fn(),
}));
import { loadConfig, resolveClient } from '../../src/config.js';
import { scanSessions } from '../../src/sessions/claude-scanner.js';
import { scanCoworkSessions } from '../../src/sessions/cowork-scanner.js';
import { logRequest } from '../../src/log-request.js';
import { fetchLastSync } from '../../src/api/last-sync.js';
import { logger } from '../../src/logger.js';

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
    (resolveClient as jest.Mock).mockReset().mockImplementation((_cfg: unknown, clientId?: string) =>
      Promise.resolve({
        client_id: clientId ?? 'default-client',
        client_name: 'Test Client',
        api_key: 'key',
        base_url: 'https://coolhandlabs.com',
        saved_at: 'now',
      })
    );
    (scanSessions as jest.Mock)
      .mockReset()
      .mockResolvedValue({ envelopes: [envelope], sessionCount: 1, filteredOut: 0, ok: true });
    (scanCoworkSessions as jest.Mock)
      .mockReset()
      .mockResolvedValue({ envelopes: [], sessionCount: 0, filteredOut: 0, ok: true });
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
    expect(logRequest).toHaveBeenCalledWith(envelope, { clientId: 'default-client' });
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
    // Cowork always falls back to epoch (not serverTime) — serverTime is Claude Code-only
    expect(scanCoworkSessions).toHaveBeenCalledWith({ sinceTime: new Date(0) });
  });

  test('falls back to epoch when no server time and no local state', async () => {
    await run({});
    expect(scanSessions).toHaveBeenCalledWith({ sinceTime: new Date(0) });
    expect(scanCoworkSessions).toHaveBeenCalledWith({ sinceTime: new Date(0) });
  });

  test('advances coworkLastSyncAt after a fully successful run', async () => {
    await run({});
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'capture-state.json'), 'utf8'));
    expect(typeof raw.coworkLastSyncAt).toBe('string');
  });

  test('does NOT advance coworkLastSyncAt when Cowork scan returned ok:false', async () => {
    (scanCoworkSessions as jest.Mock).mockResolvedValue({ envelopes: [], sessionCount: 0, filteredOut: 0, ok: false });
    await run({});
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'capture-state.json'), 'utf8'));
    expect(raw.coworkLastSyncAt).toBeUndefined();
    // Claude Code cutoff still advances normally
    expect(typeof raw.lastSyncAt).toBe('string');
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
    (scanSessions as jest.Mock).mockResolvedValue({ envelopes: [], sessionCount: 0, filteredOut: 0, ok: true });
    const code = await run({});
    expect(code).toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });

  test('returns non-zero when an explicit --client-id does not match any stored client', async () => {
    const { CliError } = await import('../../src/errors.js');
    (resolveClient as jest.Mock).mockRejectedValueOnce(
      new CliError('CLIENT_NOT_FOUND', 'No client "bad-id" is configured.')
    );
    // The outer catch converts CliError to an exit code rather than re-throwing.
    const code = await run({ clientId: 'bad-id' });
    expect(code).not.toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });

  test('proceeds unauthenticated when NOT_CONFIGURED and no clients are stored (dry-run without credentials)', async () => {
    const { CliError } = await import('../../src/errors.js');
    // No clients stored — the unauthenticated path should be taken silently.
    (loadConfig as jest.Mock).mockResolvedValueOnce({
      version: 1,
      clients: {},
      default_client_id: null,
    });
    (resolveClient as jest.Mock).mockRejectedValueOnce(
      new CliError('NOT_CONFIGURED', 'Not logged in.')
    );
    const code = await run({ dryRun: true });
    expect(code).toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });

  test('surfaces NOT_CONFIGURED when clients are stored but resolution fails (non-TTY, no default)', async () => {
    const { CliError } = await import('../../src/errors.js');
    // Clients are stored but none could be auto-selected — error must propagate.
    (loadConfig as jest.Mock).mockResolvedValueOnce({
      version: 1,
      clients: {
        acme: { client_id: 'acme', client_name: 'Acme', api_key: 'k', base_url: 'https://coolhandlabs.com', saved_at: 'now' },
        beta: { client_id: 'beta', client_name: 'Beta', api_key: 'k2', base_url: 'https://coolhandlabs.com', saved_at: 'now' },
      },
      default_client_id: null,
    });
    (resolveClient as jest.Mock).mockRejectedValueOnce(
      new CliError('NOT_CONFIGURED', 'Multiple clients configured but no default is set.')
    );
    const code = await run({});
    expect(code).not.toBe(0);
    expect(logRequest).not.toHaveBeenCalled();
  });

  describe('upload filters (time period + location)', () => {
    test('--since overrides the reference time for both scanners', async () => {
      await run({ since: '2026-06-01' });
      const claudeOpts = (scanSessions as jest.Mock).mock.calls[0][0];
      const coworkOpts = (scanCoworkSessions as jest.Mock).mock.calls[0][0];
      expect(claudeOpts.sinceTime).toEqual(new Date(2026, 5, 1, 0, 0, 0, 0));
      expect(coworkOpts.sinceTime).toEqual(new Date(2026, 5, 1, 0, 0, 0, 0));
    });

    test('--projects-dir is forwarded to scanSessions', async () => {
      await run({ projectsDir: 'C:/custom/projects' });
      const claudeOpts = (scanSessions as jest.Mock).mock.calls[0][0];
      expect(claudeOpts.projectsDir).toBe('C:/custom/projects');
    });

    test('--until wires a preFilter that rejects files modified after the bound', async () => {
      await run({ until: '2026-06-30' });
      const claudeOpts = (scanSessions as jest.Mock).mock.calls[0][0];
      expect(typeof claudeOpts.preFilter).toBe('function');
      const julyFile = { sessionId: 's', project: 'p', mtimeMs: new Date(2026, 6, 15).getTime(), source: 'claude-code' as const };
      const juneFile = { sessionId: 's', project: 'p', mtimeMs: new Date(2026, 5, 15).getTime(), source: 'claude-code' as const };
      expect(claudeOpts.preFilter(julyFile)).toBe(false);
      expect(claudeOpts.preFilter(juneFile)).toBe(true);
    });

    test('--project include list wires a preFilter matching project folders', async () => {
      await run({ projects: ['coolhand-cli'] });
      const claudeOpts = (scanSessions as jest.Mock).mock.calls[0][0];
      const matching = { sessionId: 's', project: 'C--Users-x-coolhand-cli', mtimeMs: 1, source: 'claude-code' as const };
      const other = { sessionId: 's', project: 'C--Users-x-other-repo', mtimeMs: 1, source: 'claude-code' as const };
      const cowork = { sessionId: 's', project: null, mtimeMs: 1, source: 'cowork' as const };
      expect(claudeOpts.preFilter(matching)).toBe(true);
      expect(claudeOpts.preFilter(other)).toBe(false);
      expect(claudeOpts.preFilter(cowork)).toBe(false);
    });

    test('no preFilter is wired when no filter flags are given', async () => {
      await run({});
      const claudeOpts = (scanSessions as jest.Mock).mock.calls[0][0];
      expect(claudeOpts.preFilter).toBeUndefined();
    });

    test('a narrowing run does not advance lastSyncAt or coworkLastSyncAt even on full success', async () => {
      const code = await run({ since: '7d' });
      expect(code).toBe(0);
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'capture-state.json'), 'utf8'));
      expect(raw.lastSyncAt).toBeUndefined();
      expect(raw.coworkLastSyncAt).toBeUndefined();
    });

    test('an invalid --since value returns USER_ERROR', async () => {
      const code = await run({ since: 'yesterday-ish' });
      expect(code).toBe(1);
      expect(logRequest).not.toHaveBeenCalled();
    });

    test('--since after --until returns USER_ERROR', async () => {
      const code = await run({ since: '2026-07-01', until: '2026-06-01' });
      expect(code).toBe(1);
      expect(logRequest).not.toHaveBeenCalled();
    });

    test('dry-run JSON output includes the filtered count from both scanners', async () => {
      (scanSessions as jest.Mock).mockResolvedValue({ envelopes: [], sessionCount: 0, filteredOut: 2, ok: true });
      (scanCoworkSessions as jest.Mock).mockResolvedValue({ envelopes: [], sessionCount: 0, filteredOut: 1, ok: true });
      const jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
      try {
        await run({ dryRun: true, json: true, projects: ['x'] });
        expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ filtered: 3 }));
      } finally {
        jsonSpy.mockRestore();
      }
    });
  });
});

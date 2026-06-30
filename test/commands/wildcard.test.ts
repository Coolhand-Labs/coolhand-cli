import { run } from '../../src/commands/wildcard.js';
import { CliError } from '../../src/errors.js';

const createFeedbackMock = jest.fn().mockResolvedValue({ id: 1 });

jest.mock('coolhand-node', () => ({
  Coolhand: jest.fn().mockImplementation(() => ({
    createFeedback: createFeedbackMock,
  })),
}));

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn().mockResolvedValue({ version: 1, default_client_id: 'acme', clients: {} }),
  resolveClient: jest.fn().mockResolvedValue({
    client_id: 'acme',
    client_name: 'Acme',
    api_key: 'pub_key',
    base_url: 'https://coolhandlabs.com',
    saved_at: 'now',
  }),
}));

import { Coolhand } from 'coolhand-node';
import { resolveClient } from '../../src/config.js';
import { logger } from '../../src/logger.js';

describe('wildcard command', () => {
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let jsonSpy: jest.SpyInstance;

  beforeEach(() => {
    createFeedbackMock.mockReset().mockResolvedValue({ id: 1 });
    (Coolhand as jest.Mock).mockClear();
    (resolveClient as jest.Mock).mockResolvedValue({
      client_id: 'acme',
      client_name: 'Acme',
      api_key: 'pub_key',
      base_url: 'https://coolhandlabs.com',
      saved_at: 'now',
    });
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    jsonSpy.mockRestore();
  });

  test('submits the complaint tagged creator_type agent and exits 0', async () => {
    const code = await run({ complaint: 'no internet access', agentName: 'code-review-agent' });
    expect(code).toBe(0);
    expect(createFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        explanation: 'no internet access',
        creator_unique_id: 'code-review-agent',
        creator_type: 'agent',
      })
    );
  });

  test('forwards thinking as original_output and log id as llm_request_log_id', async () => {
    await run({ complaint: 'blocked', agentName: 'a', thinking: 'I tried curl but it is blocked', logId: 42 });
    expect(createFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        original_output: 'I tried curl but it is blocked',
        llm_request_log_id: 42,
      })
    );
  });

  test('omits original_output and llm_request_log_id when not provided', async () => {
    await run({ complaint: 'blocked', agentName: 'a' });
    const sent = createFeedbackMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('original_output');
    expect(Object.keys(sent)).not.toContain('llm_request_log_id');
  });

  test('passes the stored public api_key and base_url to the SDK', async () => {
    await run({ complaint: 'blocked', agentName: 'a' });
    expect(Coolhand).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pub_key', baseUrl: 'https://coolhandlabs.com', silent: true })
    );
  });

  test('still de-loops (exit 0) and warns when the SDK throws', async () => {
    createFeedbackMock.mockRejectedValue(new Error('network down'));
    const code = await run({ complaint: 'x', agentName: 'a' });
    expect(code).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('could not be recorded'));
  });

  test('de-loops (exit 0) without claiming a recording when the write is not confirmed (SDK returns null)', async () => {
    createFeedbackMock.mockResolvedValue(null);
    const code = await run({ complaint: 'x', agentName: 'a' });
    expect(code).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('could not be recorded'));
  });

  test('de-loops (exit 0) and skips submission when no client and no api key env var', async () => {
    (resolveClient as jest.Mock).mockRejectedValueOnce(
      new CliError('NOT_CONFIGURED', 'Not logged in.')
    );
    const previous = process.env.COOLHAND_API_KEY;
    delete process.env.COOLHAND_API_KEY;
    try {
      const code = await run({ complaint: 'x', agentName: 'a' });
      expect(code).toBe(0);
      expect(createFeedbackMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('could not be recorded'));
    } finally {
      if (previous !== undefined) {
        process.env.COOLHAND_API_KEY = previous;
      }
    }
  });

  test('exits 0 on a confirmed write with --json', async () => {
    const code = await run({ complaint: 'x', agentName: 'a', json: true });
    expect(code).toBe(0);
  });

  test('forwards clientId to resolveClient when provided', async () => {
    await run({ complaint: 'x', agentName: 'a', clientId: 'acme' });
    expect(resolveClient).toHaveBeenCalledWith(expect.anything(), 'acme');
  });

  test('de-loops (exit 0) and warns when resolveClient throws CLIENT_NOT_FOUND for a bad --client-id', async () => {
    (resolveClient as jest.Mock).mockRejectedValueOnce(
      new CliError('CLIENT_NOT_FOUND', 'No client "bad-id" is configured.')
    );
    const code = await run({ complaint: 'x', agentName: 'a', clientId: 'bad-id' });
    expect(code).toBe(0);
    expect(createFeedbackMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not record blocker feedback'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('could not be recorded'));
  });
});

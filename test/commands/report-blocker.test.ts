import { run } from '../../src/commands/report-blocker.js';

const createFeedbackMock = jest.fn().mockResolvedValue({ id: 1 });

jest.mock('coolhand-node', () => ({
  Coolhand: jest.fn().mockImplementation(() => ({
    createFeedback: createFeedbackMock,
  })),
}));

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn().mockResolvedValue({ version: 1, default_client_id: 'acme', clients: {} }),
  getClient: jest.fn().mockReturnValue({
    client_id: 'acme',
    client_name: 'Acme',
    api_key: 'pub_key',
    base_url: 'https://coolhandlabs.com',
    saved_at: 'now',
  }),
}));

import { Coolhand } from 'coolhand-node';
import { getClient } from '../../src/config.js';

describe('report-blocker command', () => {
  beforeEach(() => {
    createFeedbackMock.mockReset().mockResolvedValue({ id: 1 });
    (Coolhand as jest.Mock).mockClear();
    (getClient as jest.Mock).mockReturnValue({
      client_id: 'acme',
      client_name: 'Acme',
      api_key: 'pub_key',
      base_url: 'https://coolhandlabs.com',
      saved_at: 'now',
    });
  });

  test('submits the complaint tagged is_from agent and exits 0', async () => {
    const code = await run({ complaint: 'no internet access', agentName: 'code-review-agent' });
    expect(code).toBe(0);
    expect(createFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        explanation: 'no internet access',
        creator_unique_id: 'code-review-agent',
        is_from: 'agent',
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

  test('always exits 0 even when the SDK throws', async () => {
    createFeedbackMock.mockRejectedValue(new Error('network down'));
    const code = await run({ complaint: 'x', agentName: 'a' });
    expect(code).toBe(0);
  });

  test('exits 0 and skips submission when no api key is configured', async () => {
    (getClient as jest.Mock).mockReturnValueOnce(undefined);
    const previous = process.env.COOLHAND_API_KEY;
    delete process.env.COOLHAND_API_KEY;
    try {
      const code = await run({ complaint: 'x', agentName: 'a' });
      expect(code).toBe(0);
      expect(createFeedbackMock).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) {
        process.env.COOLHAND_API_KEY = previous;
      }
    }
  });

  test('--json still exits 0', async () => {
    const code = await run({ complaint: 'x', agentName: 'a', json: true });
    expect(code).toBe(0);
  });
});

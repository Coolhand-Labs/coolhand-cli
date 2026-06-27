// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting rule).
const mockLogRequest = jest.fn();
const mockCoolhandCtor = jest.fn();

jest.mock('coolhand-node', () => ({
  Coolhand: mockCoolhandCtor,
}));
jest.mock('../src/config.js', () => ({
  loadConfig: jest.fn(),
  getClient: jest.fn(),
}));

import { logRequest } from '../src/log-request.js';
import { loadConfig, getClient } from '../src/config.js';

const envelope = {
  url: 'claudecode://session/s',
  method: 'POST',
  status_code: 200,
  request_body: { messages: [{ role: 'user', content: 'hi' }] },
  response_body: { id: 'r', type: 'message', role: 'assistant', content: [] },
};

const fakeClient = {
  client_id: 'c1',
  api_key: 'pub_key',
  base_url: 'https://example.com',
  default: true,
};

describe('logRequest (coolhand-node SDK transport)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.COOLHAND_API_KEY;
    (loadConfig as jest.Mock).mockResolvedValue({});
    (getClient as jest.Mock).mockReturnValue(fakeClient);
    mockCoolhandCtor.mockImplementation(() => ({ logRequest: mockLogRequest }));
    mockLogRequest.mockResolvedValue({ id: 1 });
  });

  test('constructs Coolhand with the client api_key and base_url', async () => {
    await logRequest(envelope);
    expect(mockCoolhandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pub_key', baseUrl: 'https://example.com' })
    );
  });

  test('submits the envelope with the cli collector', async () => {
    await logRequest(envelope);
    expect(mockLogRequest).toHaveBeenCalledWith(envelope, { collector: expect.stringMatching(/^coolhand-cli-[\d.]+\/claude-code$/) });
  });

  test('returns the SDK result on success', async () => {
    mockLogRequest.mockResolvedValue({ id: 42 });
    await expect(logRequest(envelope)).resolves.toEqual({ id: 42 });
  });

  test('throws NOT_CONFIGURED when no api key is available', async () => {
    (getClient as jest.Mock).mockReturnValue(undefined);
    await expect(logRequest(envelope)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(mockLogRequest).not.toHaveBeenCalled();
  });

  test('throws CLIENT_NOT_FOUND when a named client is missing', async () => {
    (getClient as jest.Mock).mockReturnValue(undefined);
    await expect(logRequest(envelope, { clientId: 'nope' })).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  test('translates a null SDK result into INGEST_ERROR (failed submit)', async () => {
    mockLogRequest.mockResolvedValue(null);
    await expect(logRequest(envelope)).rejects.toMatchObject({ code: 'INGEST_ERROR' });
  });

  test('maps a base_url rejection from the SDK constructor to INVALID_BASE_URL', async () => {
    mockCoolhandCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(logRequest(envelope)).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
  });
});

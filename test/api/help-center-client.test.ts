// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting rule).
const mockServiceCtor = jest.fn();

class MockHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

jest.mock('coolhand-node', () => ({
  PublicContentService: mockServiceCtor,
  HttpError: MockHttpError,
}));
jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
}));

import { getHelpCenterClient, mapHelpCenterHttpError } from '../../src/api/help-center-client.js';
import { loadConfig } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import { HttpError } from 'coolhand-node';

const storedClient = {
  client_id: 'client-1',
  client_name: 'Test Client',
  api_key: 'pub_key',
  private_key: 'priv_key_abc',
  base_url: 'https://coolhandlabs.com',
  saved_at: new Date().toISOString(),
};
const otherClient = { ...storedClient, client_id: 'client-2', client_name: 'Other', api_key: 'other_pub' };

function config(clients: Array<typeof storedClient>, defaultId?: string): unknown {
  return {
    clients: Object.fromEntries(clients.map((c) => [c.client_id, c])),
    default_client_id: defaultId,
  };
}

describe('getHelpCenterClient', () => {
  let warnSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let savedClientIdEnv: string | undefined;

  beforeEach(() => {
    jest.resetAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue(config([storedClient]));
    mockServiceCtor.mockImplementation((opts) => ({ __opts: opts }));
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    savedClientIdEnv = process.env.COOLHAND_CLIENT_ID;
    delete process.env.COOLHAND_CLIENT_ID;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    stderrSpy.mockRestore();
    if (savedClientIdEnv !== undefined) {
      process.env.COOLHAND_CLIENT_ID = savedClientIdEnv;
    }
  });

  test('with no stored client, builds the service with no key against the default server', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(config([]));
    const { usesStoredKey } = await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith({
      apiKey: undefined,
      baseUrl: 'https://coolhandlabs.com',
      silent: true,
    });
    expect(usesStoredKey).toBe(false);
  });

  test('sends the stored public api_key, preferring it over the private key', async () => {
    const { usesStoredKey } = await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pub_key', baseUrl: 'https://coolhandlabs.com' })
    );
    expect(usesStoredKey).toBe(true);
  });

  test('falls back to the private key when the client has no public key', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(config([{ ...storedClient, api_key: undefined as never }]));
    await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'priv_key_abc' }));
  });

  test('uses the stored client base_url', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(config([{ ...storedClient, base_url: 'https://staging.example.com' }]));
    await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pub_key', baseUrl: 'https://staging.example.com' })
    );
  });

  test('never sends the stored key to a different --base-url, nor lets node read COOLHAND_API_KEY there', async () => {
    const { usesStoredKey } = await getHelpCenterClient({ baseUrl: 'http://127.0.0.1:3111' });
    expect(mockServiceCtor).toHaveBeenCalledWith({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:3111',
      silent: true,
    });
    expect(usesStoredKey).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anonymously'));
  });

  test('with no stored client, a --base-url call is anonymous and node may not read COOLHAND_API_KEY', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(config([]));
    await getHelpCenterClient({ baseUrl: 'http://127.0.0.1:3111' });
    expect(mockServiceCtor).toHaveBeenCalledWith({ apiKey: '', baseUrl: 'http://127.0.0.1:3111', silent: true });
  });

  test('still sends the stored key when --base-url names the same server (trailing slash ignored)', async () => {
    await getHelpCenterClient({ baseUrl: 'https://coolhandlabs.com/' });
    expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'pub_key' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  describe('selecting among stored clients never prompts', () => {
    const many = config([storedClient, otherClient]);

    test('--client-id picks that client', async () => {
      (loadConfig as jest.Mock).mockResolvedValue(many);
      await getHelpCenterClient({ clientId: 'client-2' });
      expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'other_pub' }));
    });

    test('an unknown --client-id is CLIENT_NOT_FOUND', async () => {
      await expect(getHelpCenterClient({ clientId: 'nope' })).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    });

    test('an empty --client-id is INVALID_ARGS', async () => {
      await expect(getHelpCenterClient({ clientId: '' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    });

    test('several clients and no default read anonymously instead of prompting', async () => {
      (loadConfig as jest.Mock).mockResolvedValue(many);
      const { usesStoredKey } = await getHelpCenterClient();
      expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
      expect(usesStoredKey).toBe(false);
    });

    test('a stale default with several clients reads anonymously', async () => {
      (loadConfig as jest.Mock).mockResolvedValue(config([storedClient, otherClient], 'deleted'));
      const { usesStoredKey } = await getHelpCenterClient();
      expect(usesStoredKey).toBe(false);
    });

    test('a stale default with exactly one client uses that client', async () => {
      (loadConfig as jest.Mock).mockResolvedValue(config([storedClient], 'deleted'));
      const { usesStoredKey } = await getHelpCenterClient();
      expect(usesStoredKey).toBe(true);
    });

    test('the configured default wins among several clients', async () => {
      (loadConfig as jest.Mock).mockResolvedValue(config([storedClient, otherClient], 'client-2'));
      await getHelpCenterClient();
      expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'other_pub' }));
    });

    test('COOLHAND_CLIENT_ID wins over the default, and an unknown value is ignored', async () => {
      (loadConfig as jest.Mock).mockResolvedValue(config([storedClient, otherClient], 'client-1'));
      process.env.COOLHAND_CLIENT_ID = 'client-2';
      await getHelpCenterClient();
      expect(mockServiceCtor).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'other_pub' }));

      process.env.COOLHAND_CLIENT_ID = 'missing';
      await getHelpCenterClient();
      expect(mockServiceCtor).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'pub_key' }));
    });
  });

  test('throws INVALID_BASE_URL when the SDK constructor rejects the base URL', async () => {
    mockServiceCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(getHelpCenterClient({ baseUrl: 'http://example.com' })).rejects.toMatchObject({
      code: 'INVALID_BASE_URL',
    });
  });
});

describe('mapHelpCenterHttpError', () => {
  const stored = { service: {} as never, usesStoredKey: true };
  const anonymous = { service: {} as never, usesStoredKey: false };

  test('maps a 401 with a stored key to a re-authenticate hint', () => {
    const err = mapHelpCenterHttpError(new HttpError('Unauthorized', 401), stored, 'not found');
    expect(err.code).toBe('HELP_CENTER_ERROR');
    expect(err.message).toContain('coolhand login');
  });

  test('maps a 401 without a stored key to a COOLHAND_API_KEY hint', () => {
    const err = mapHelpCenterHttpError(new HttpError('Unauthorized', 401), anonymous, 'not found');
    expect(err.code).toBe('HELP_CENTER_ERROR');
    expect(err.message).toContain('COOLHAND_API_KEY');
  });

  test('maps a 404 to the caller-supplied not-found message', () => {
    const err = mapHelpCenterHttpError(new HttpError('Not Found', 404), anonymous, 'Help article "x" not found.');
    expect(err.message).toBe('Help article "x" not found.');
  });

  test('maps a 429 to a wait-and-retry message', () => {
    const err = mapHelpCenterHttpError(new HttpError('Too Many Requests', 429), anonymous, 'not found');
    expect(err.message).toContain('30 requests per minute');
    expect(err.message).toContain('Wait a minute');
  });

  test('passes any other HTTP error message through unchanged', () => {
    const err = mapHelpCenterHttpError(
      new HttpError('Help center request failed (500): boom', 500),
      anonymous,
      'not found'
    );
    expect(err.message).toBe('Help center request failed (500): boom');
  });

  test('wraps a non-HTTP error', () => {
    const err = mapHelpCenterHttpError(new Error('ECONNREFUSED'), anonymous, 'not found');
    expect(err.code).toBe('HELP_CENTER_ERROR');
    expect(err.message).toBe('Help center request failed: ECONNREFUSED');
  });
});

import { CliError } from '../../src/errors.js';

jest.mock('../../src/proxy/certs.js', () => ({
  getOrCreateCA: jest.fn(),
  getCertPath: jest.fn(),
}));
jest.mock('../../src/proxy/proxy.js', () => ({
  startProxy: jest.fn(),
}));

import { endpointForBaseUrl } from '../../src/proxy/wrap-runner.js';

describe('endpointForBaseUrl', () => {
  test('returns undefined for the default base_url', () => {
    expect(endpointForBaseUrl('https://coolhandlabs.com')).toBeUndefined();
  });

  test('returns undefined for an empty base_url', () => {
    expect(endpointForBaseUrl('')).toBeUndefined();
  });

  test('builds the ingest endpoint for a non-default https base_url', () => {
    expect(endpointForBaseUrl('https://staging.coolhandlabs.com')).toBe(
      'https://staging.coolhandlabs.com/api/v2/llm_request_logs'
    );
  });

  test('allows http for localhost', () => {
    expect(endpointForBaseUrl('http://localhost:4000')).toBe(
      'http://localhost:4000/api/v2/llm_request_logs'
    );
  });

  test('rejects http for a non-loopback host', () => {
    expect(() => endpointForBaseUrl('http://internal-mirror.corp')).toThrow(CliError);
    try {
      endpointForBaseUrl('http://internal-mirror.corp');
      throw new Error('expected endpointForBaseUrl to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('INVALID_BASE_URL');
    }
  });

  test('rejects an unparseable base_url', () => {
    expect(() => endpointForBaseUrl('not a url')).toThrow(CliError);
  });
});

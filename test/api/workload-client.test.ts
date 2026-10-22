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
  Coolhand: jest.fn(),
  HttpError: MockHttpError,
}));
jest.mock('../../src/api/template-client.js', () => ({
  getTemplateClient: jest.fn(),
}));

import { getWorkloadClient, mapWorkloadHttpError } from '../../src/api/workload-client.js';
import { getTemplateClient } from '../../src/api/template-client.js';
import { HttpError } from 'coolhand-node';

describe('getWorkloadClient', () => {
  test('delegates to the private-key template client, forwarding clientId', async () => {
    const fake = { searchWorkloads: jest.fn() };
    (getTemplateClient as jest.Mock).mockResolvedValue(fake);
    await expect(getWorkloadClient({ clientId: 'acme' })).resolves.toBe(fake);
    expect(getTemplateClient).toHaveBeenCalledWith({ clientId: 'acme' });
  });
});

describe('mapWorkloadHttpError', () => {
  test('401 says a private API key is required', () => {
    const err = mapWorkloadHttpError(new HttpError('nope', 401));
    expect(err.code).toBe('WORKLOAD_ERROR');
    expect(err.message).toContain('private API key is required');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('422 surfaces the server message untouched', () => {
    const body = 'Workload request failed (422): {"errors":{"since":["is invalid"]}}';
    const err = mapWorkloadHttpError(new HttpError(body, 422));
    expect(err.code).toBe('WORKLOAD_ERROR');
    expect(err.message).toBe(body);
  });

  test('504 is reported as retryable with a narrowing hint', () => {
    const err = mapWorkloadHttpError(new HttpError('timeout', 504));
    expect(err.message).toContain('retryable');
    expect(err.message).toContain('--per-page');
  });

  test('a plain Error (network, invalid Date) is wrapped', () => {
    const err = mapWorkloadHttpError(new Error('ECONNREFUSED'));
    expect(err.message).toBe('Workload request failed: ECONNREFUSED');
  });
});

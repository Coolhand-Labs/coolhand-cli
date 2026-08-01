import { shouldCapture, flattenHeaders, sanitizeHeaders } from '../../src/proxy/interceptor.js';

describe('shouldCapture', () => {
  test('returns true for Anthropic API URLs', () => {
    expect(shouldCapture('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  test('returns true for OpenAI API URLs', () => {
    expect(shouldCapture('https://api.openai.com/v1/chat/completions')).toBe(true);
  });

  test('returns false for non-AI URLs', () => {
    expect(shouldCapture('https://example.com/api/data')).toBe(false);
    expect(shouldCapture('https://google.com')).toBe(false);
  });
});

describe('flattenHeaders', () => {
  test('passes through string values unchanged', () => {
    expect(flattenHeaders({ 'content-type': 'application/json' }))
      .toEqual({ 'content-type': 'application/json' });
  });

  test('joins array values with ", "', () => {
    expect(flattenHeaders({ 'set-cookie': ['a=1', 'b=2'] }))
      .toEqual({ 'set-cookie': 'a=1, b=2' });
  });

  test('drops undefined values', () => {
    expect(flattenHeaders({ 'x-forwarded-for': undefined, 'host': 'example.com' }))
      .toEqual({ 'host': 'example.com' });
  });

  test('handles empty input', () => {
    expect(flattenHeaders({})).toEqual({});
  });
});

describe('sanitizeHeaders', () => {
  test('redacts authorization header', () => {
    const result = sanitizeHeaders({ authorization: 'Bearer sk-secret' });
    expect(result.authorization).toBe('[REDACTED]');
  });

  test('redacts x-api-key header', () => {
    const result = sanitizeHeaders({ 'x-api-key': 'sk-secret' });
    expect(result['x-api-key']).toBe('[REDACTED]');
  });

  test('redacts cf-aig-authorization header', () => {
    const result = sanitizeHeaders({ 'cf-aig-authorization': 'secret-token' });
    expect(result['cf-aig-authorization']).toBe('[REDACTED]');
  });

  test('redacts proxy-authorization header', () => {
    const result = sanitizeHeaders({ 'proxy-authorization': 'Basic abc' });
    expect(result['proxy-authorization']).toBe('[REDACTED]');
  });

  test('redacts cookie and set-cookie headers', () => {
    const result = sanitizeHeaders({ cookie: 'session=abc', 'set-cookie': 'session=abc; Path=/' });
    expect(result.cookie).toBe('[REDACTED]');
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  test('is case-insensitive for sensitive key matching', () => {
    const result = sanitizeHeaders({ Authorization: 'Bearer sk-secret' });
    expect(result['Authorization']).toBe('[REDACTED]');
  });

  test('passes through non-sensitive headers', () => {
    const result = sanitizeHeaders({ 'content-type': 'application/json', host: 'api.example.com' });
    expect(result['content-type']).toBe('application/json');
    expect(result.host).toBe('api.example.com');
  });
});

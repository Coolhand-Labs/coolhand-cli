import { shouldCapture, flattenHeaders, sanitizeHeaders, sanitizeURL } from '../../src/proxy/interceptor.js';

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

describe('sanitizeURL', () => {
  test('redacts the key query param', () => {
    expect(sanitizeURL('https://generativelanguage.googleapis.com/v1/models?key=AIzaSy-secret'))
      .toBe('https://generativelanguage.googleapis.com/v1/models?key=%5BREDACTED%5D');
  });

  test.each(['api_key', 'apikey', 'token', 'access_token', 'secret'])(
    'redacts the %s query param',
    (param) => {
      const url = `https://api.example.com/v1/data?${param}=super-secret`;
      const result = sanitizeURL(url);
      expect(new URL(result).searchParams.get(param)).toBe('[REDACTED]');
    }
  );

  test('is case-insensitive for the param name', () => {
    const result = sanitizeURL('https://api.example.com/v1/data?Key=super-secret');
    expect(new URL(result).searchParams.get('Key')).toBe('[REDACTED]');
  });

  test('redacts only the sensitive param when mixed with non-sensitive ones', () => {
    const result = sanitizeURL('https://api.example.com/v1/data?model=gpt-4&api_key=super-secret');
    const parsed = new URL(result);
    expect(parsed.searchParams.get('model')).toBe('gpt-4');
    expect(parsed.searchParams.get('api_key')).toBe('[REDACTED]');
  });

  test('passes through non-sensitive query params unchanged', () => {
    const url = 'https://api.example.com/v1/data?model=gpt-4&stream=true';
    expect(sanitizeURL(url)).toBe(url);
  });

  test('passes through URLs with no query string unchanged', () => {
    const url = 'https://api.anthropic.com/v1/messages';
    expect(sanitizeURL(url)).toBe(url);
  });

  test('returns the input unchanged for an unparseable URL', () => {
    expect(sanitizeURL('not a url')).toBe('not a url');
    expect(sanitizeURL('')).toBe('');
  });
});

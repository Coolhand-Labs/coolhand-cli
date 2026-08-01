import { isAllowedBaseUrlScheme, isLoopbackHostname } from '../src/base-url.js';

describe('isLoopbackHostname', () => {
  test('accepts localhost, 127.0.0.1, and bracketed ::1', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
  });

  test('rejects other hosts', () => {
    expect(isLoopbackHostname('internal-mirror.corp')).toBe(false);
    expect(isLoopbackHostname('10.0.0.5')).toBe(false);
    expect(isLoopbackHostname('coolhandlabs.com')).toBe(false);
  });
});

describe('isAllowedBaseUrlScheme', () => {
  test('allows https for any host', () => {
    expect(isAllowedBaseUrlScheme(new URL('https://coolhandlabs.com'))).toBe(true);
    expect(isAllowedBaseUrlScheme(new URL('https://internal-mirror.corp'))).toBe(true);
  });

  test('allows http only for loopback hosts', () => {
    expect(isAllowedBaseUrlScheme(new URL('http://localhost:3000'))).toBe(true);
    expect(isAllowedBaseUrlScheme(new URL('http://127.0.0.1:3000'))).toBe(true);
    expect(isAllowedBaseUrlScheme(new URL('http://[::1]:3000'))).toBe(true);
  });

  test('rejects http for non-loopback hosts', () => {
    expect(isAllowedBaseUrlScheme(new URL('http://internal-mirror.corp'))).toBe(false);
    expect(isAllowedBaseUrlScheme(new URL('http://10.0.0.5'))).toBe(false);
  });

  test('rejects non-http(s) schemes', () => {
    expect(isAllowedBaseUrlScheme(new URL('file:///etc/passwd'))).toBe(false);
  });
});

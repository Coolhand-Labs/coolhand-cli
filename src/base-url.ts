/**
 * Mirrors the scheme rule coolhand-node's `BaseService` enforces on `baseUrl`:
 * https:// is always allowed; http:// only for localhost/127.0.0.1/[::1].
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isAllowedBaseUrlScheme(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

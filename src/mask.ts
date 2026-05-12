/**
 * Returns a non-secret representation of an API token suitable for display.
 * For tokens longer than 16 characters, returns the first 8 and last 4
 * separated by an ellipsis. Shorter values are fully masked.
 */
export function maskToken(token: string): string {
  if (!token || token.length <= 16) {
    return '***';
  }
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

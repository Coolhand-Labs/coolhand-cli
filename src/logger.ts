/**
 * Strips anything that looks like a Coolhand API key from a string, so we never
 * inadvertently log a raw token through an error message. Real tokens are raw
 * 64-char hex strings; this pattern also catches longer hex (forwards-compat)
 * and the legacy `ch_pub_…` form, with low false-positive risk (redacting an
 * unrelated 40+ hex SHA in an error message is harmless).
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[a-f0-9]{40,}\b/gi,
  /ch_pub_[A-Za-z0-9_-]{8,}/g,
  /ch_priv_[A-Za-z0-9_-]{8,}/g,
];

export function redact(text: string): string {
  return TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, 'REDACTED'), text);
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  json(payload: unknown): void;
}

function defaultInfo(message: string): void {
  process.stderr.write(`${redact(message)}\n`);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${redact(message)}\n`);
}

function defaultJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export const logger: Logger = {
  info: defaultInfo,
  warn: defaultWarn,
  json: defaultJson,
};

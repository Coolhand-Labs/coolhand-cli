/**
 * Strips anything that looks like a Coolhand public API key from a string,
 * so we never inadvertently log a raw token through an error message.
 */
const TOKEN_PATTERN = /ch_pub_[A-Za-z0-9_-]{8,}/g;

export function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, 'ch_pub_…REDACTED');
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

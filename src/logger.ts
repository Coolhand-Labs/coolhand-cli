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

/**
 * Matches ANSI/VT100 CSI and OSC escape sequences (e.g. color codes, window-title
 * sets), so untrusted text -- a server-controlled client_name or feedback
 * explanation -- can't manipulate the terminal when printed. Built from character
 * codes (rather than a literal control-char regex) to avoid embedding raw escape
 * bytes in source.
 */
function buildAnsiEscapePattern(): RegExp {
  const esc = String.fromCharCode(0x1b);
  const bel = String.fromCharCode(0x07);
  // 7-bit forms use a two-character introducer (ESC [ / ESC ]); the single-byte C1
  // introducers (0x9B for CSI, 0x9D for OSC) stand in for the whole two-character
  // introducer, so they're matched without a following bracket.
  const c1Csi = String.fromCharCode(0x9b);
  const c1Osc = String.fromCharCode(0x9d);
  // Per ECMA-48: a CSI sequence is introducer + parameter bytes (0x30-0x3F, i.e.
  // digits and ':;<=>?') + intermediate bytes (0x20-0x2F) + a single final byte
  // (0x40-0x7E) -- not just digits/';'/'?' and a letter, which misses sequences
  // like colon-separated true-color SGR (`\x1b[38:2:255:0:0m`), sequences with an
  // intermediate byte (`\x1b[2 q`), or final bytes outside a-zA-Z (`\x1b[5@`).
  const csi = `(?:${esc}\\[|${c1Csi})[0-?]*[ -/]*[@-~]`;
  const osc = `(?:${esc}\\]|${c1Osc})[^${esc}${bel}]*(?:${bel}|${esc}\\\\)`;
  return new RegExp(`${csi}|${osc}`, 'g');
}

const ANSI_ESCAPE_PATTERN = buildAnsiEscapePattern();

export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

export function redact(text: string): string {
  const sanitized = stripAnsiEscapes(text);
  return TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, 'REDACTED'), sanitized);
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

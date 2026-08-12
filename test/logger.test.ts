import { redact, stripAnsiEscapes } from '../src/logger.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe('redact', () => {
  test('strips raw 64-char hex tokens', () => {
    const token = 'e885b463541f1d1c6002268f32bbb7c82d9a350437bd587eb429504005831148';
    const message = `Failed to send token ${token} to the listener`;
    const out = redact(message);
    expect(out).not.toContain(token);
    expect(out).toContain('REDACTED');
  });

  test('strips ch_pub_ prefixed tokens', () => {
    const token = 'ch_pub_AbCdEf0123456789xyz';
    const out = redact(`error: ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('REDACTED');
  });

  test('leaves short identifiers alone', () => {
    expect(redact('client_id x3v6n48col8d not found')).toContain('x3v6n48col8d');
  });

  test('redacts multiple tokens in one string', () => {
    const a = 'e885b463541f1d1c6002268f32bbb7c82d9a350437bd587eb429504005831148';
    const b = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const out = redact(`${a} and ${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
  });

  test('is case-insensitive for hex', () => {
    const token = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
    const out = redact(`uppercase: ${token}`);
    expect(out).not.toContain(token);
  });

  test('strips ANSI CSI sequences (e.g. color codes)', () => {
    const out = redact(`${ESC}[31mfake error${ESC}[0m`);
    expect(out).not.toContain(ESC);
    expect(out).toBe('fake error');
  });

  test('strips ANSI OSC sequences (e.g. window-title sets)', () => {
    const out = redact(`${ESC}]0;evil title${BEL}visible text`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toBe('visible text');
  });

  test('preserves normal multi-line text', () => {
    const text = 'line one\nline two\nline three';
    expect(redact(text)).toBe(text);
  });

  test('still redacts tokens after stripping ANSI escapes', () => {
    const token = 'e885b463541f1d1c6002268f32bbb7c82d9a350437bd587eb429504005831148';
    const out = redact(`${ESC}[31m${token}${ESC}[0m`);
    expect(out).not.toContain(token);
    expect(out).toContain('REDACTED');
  });
});

describe('stripAnsiEscapes', () => {
  test('removes CSI and OSC sequences without touching other text', () => {
    const input = `${ESC}[1mBold${ESC}[0m and ${ESC}]0;title${BEL}plain`;
    expect(stripAnsiEscapes(input)).toBe('Bold and plain');
  });

  test('is a no-op for text with no escape sequences', () => {
    expect(stripAnsiEscapes('hello world')).toBe('hello world');
  });

  test('strips colon-separated true-color SGR sequences', () => {
    // \x1b[38:2:255:0:0m -- colon param separator, not just ';', used by iTerm2/kitty/wezterm.
    const out = stripAnsiEscapes(`${ESC}[38:2:255:0:0mhello`);
    expect(out).not.toContain(ESC);
    expect(out).toBe('hello');
  });

  test('strips CSI sequences with an intermediate byte', () => {
    // \x1b[2 q -- DECSCUSR cursor-style change, ' ' is an ECMA-48 intermediate byte.
    const out = stripAnsiEscapes(`${ESC}[2 qhello`);
    expect(out).not.toContain(ESC);
    expect(out).toBe('hello');
  });

  test('strips CSI sequences with a final byte outside a-zA-Z', () => {
    // \x1b[5@ -- ICH (insert character), final byte '@' is outside a-zA-Z.
    const out = stripAnsiEscapes(`${ESC}[5@hello`);
    expect(out).not.toContain(ESC);
    expect(out).toBe('hello');
  });
});

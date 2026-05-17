import { redact } from '../src/logger.js';

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
});

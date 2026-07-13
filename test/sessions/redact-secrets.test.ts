import { redactSecrets } from '../../src/sessions/redact-secrets.js';

describe('redactSecrets', () => {
  test('returns empty input unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  test('leaves ordinary text alone', () => {
    expect(redactSecrets('just a normal sentence')).toBe('just a normal sentence');
  });

  test('redacts an OpenAI-style key', () => {
    const out = redactSecrets('key is sk-abcdef1234567890ABCDEF here');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abcdef1234567890ABCDEF');
  });

  test('redacts a GitHub personal access token', () => {
    const out = redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(out).toBe('[REDACTED]');
  });

  test('redacts an AWS access key id', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
  });

  test('redacts a Bearer token', () => {
    const out = redactSecrets('Authorization: Bearer abcdef.ghijkl.mnopqr');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcdef.ghijkl.mnopqr');
  });

  test('redacts the value of a KEY=value assignment but keeps the key', () => {
    const out = redactSecrets('OPENAI_API_KEY=supersecretvalue123');
    expect(out).toContain('OPENAI_API_KEY=');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('supersecretvalue123');
  });

  test('redacts a quoted secret assignment, preserving quotes', () => {
    const out = redactSecrets('password: "hunter2hunter2hunter2"');
    expect(out).not.toContain('hunter2hunter2hunter2');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a long hex blob', () => {
    expect(redactSecrets('a'.repeat(40))).toBe('[REDACTED]');
  });

  test('redacts Coolhand private tokens', () => {
    expect(redactSecrets('ch_priv_abcdefghij')).toBe('[REDACTED]');
  });

  test('redacts a quoted secret value that contains spaces', () => {
    const out = redactSecrets('secret: "my secret value with spaces"');
    expect(out).not.toContain('value with spaces');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a value hit by both the assignment and a token pattern', () => {
    const out = redactSecrets('OPENAI_API_KEY=sk-abcdef1234567890ABCDEF');
    expect(out).toContain('OPENAI_API_KEY=');
    expect(out).not.toContain('sk-abcdef1234567890ABCDEF');
    expect(out).toContain('[REDACTED]');
  });
});

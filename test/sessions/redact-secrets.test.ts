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

  test('redacts a Slack token', () => {
    const token = 'xoxb-fake-token-used-only-in-tests-000';
    const out = redactSecrets(`slack said ${token} ok`);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a Google API key', () => {
    const token = `AIza${'x'.repeat(35)}`;
    const out = redactSecrets(`url?key=${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a Stripe live secret key', () => {
    const token = `sk_live_${'a'.repeat(24)}`;
    const out = redactSecrets(token);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a JWT', () => {
    const token =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactSecrets(`token=${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a plain-JSON-object secret value (quoted key, opaque value)', () => {
    const out = redactSecrets('{"api_key": "plainOpaqueValue123"}');
    expect(out).not.toContain('plainOpaqueValue123');
    expect(out).toContain('"api_key": "[REDACTED]"');
  });

  test('redacts a JSON secret value under an uppercase env-style key name', () => {
    const out = redactSecrets('{"GITHUB_TOKEN": "plainOpaqueValue123"}');
    expect(out).not.toContain('plainOpaqueValue123');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts JSON password/access-key values, keeping surrounding structure intact', () => {
    const out = redactSecrets('{"DB_PASSWORD": "plainOpaqueValue123", "id": 42}');
    expect(out).not.toContain('plainOpaqueValue123');
    expect(out).toContain('"DB_PASSWORD": "[REDACTED]"');
    expect(out).toContain('"id": 42');
  });

  test('redacts an OpenSSH private key block', () => {
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ',
      'AAACDfakekeymaterialfakekeymaterialfakekeymaterialfake=',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`here is my key:\n${key}\nthanks`);
    expect(out).not.toContain('fakekeymaterial');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('here is my key:');
    expect(out).toContain('thanks');
  });

  test('redacts an RSA and a PGP private key block by their BEGIN/END markers', () => {
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nfakebase64body\n-----END RSA PRIVATE KEY-----';
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nfakebase64body\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(redactSecrets(rsa)).toBe('[REDACTED]');
    expect(redactSecrets(pgp)).toBe('[REDACTED]');
  });

  test('redacts an Authorization: Basic header', () => {
    const out = redactSecrets('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
  });

  test('redacts a Slack webhook URL assigned to a variable', () => {
    const out = redactSecrets('SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXXXXXX');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('T000/B000/XXXXXXXX');
  });

  test('redacts a Discord webhook URL', () => {
    const out = redactSecrets('https://discord.com/api/webhooks/123456789/abcDEF-token');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcDEF-token');
  });
});

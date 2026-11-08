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

  test('redacts a quoted secret with spaces inside JSON-escaped quotes', () => {
    const out = redactSecrets(JSON.stringify({ command: 'export DB_PASSWORD="hunter2 correct horse" && run' }));
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('correct horse');
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

  test('redacts SECRET_KEY, auth_key and passphrase assignments', () => {
    for (const line of ['SECRET_KEY=abc123def', 'auth_key=abc123def', 'passphrase: hunter2hunter2']) {
      const out = redactSecrets(line);
      expect(out).toContain('[REDACTED]');
      expect(out).not.toMatch(/abc123def|hunter2/);
    }
  });

  test('redacts credentials embedded in a URL but keeps the host', () => {
    const out = redactSecrets('postgres://admin:s3cr3tpass@db.internal:5432/app');
    expect(out).not.toContain('s3cr3tpass');
    expect(out).toContain('db.internal:5432/app');
  });

  test('redacts npm, GitLab and Hugging Face tokens', () => {
    const tokens = [`npm_${'a'.repeat(36)}`, `glpat-${'b'.repeat(20)}`, `hf_${'c'.repeat(34)}`];
    for (const token of tokens) {
      expect(redactSecrets(`token is ${token} ok`)).not.toContain(token);
    }
  });

  test('does not mangle ordinary text with a scheme and no credentials', () => {
    expect(redactSecrets('see https://example.com/a/b for details')).toBe('see https://example.com/a/b for details');
  });
});

describe('redactSecrets: command lines, env files and cookies', () => {
  test.each([
    ['curl -u admin:hunter2 https://x', 'hunter2'],
    ['cd x && curl -v --user admin:hunter2 https://x', 'hunter2'],
    ['mysql --password hunter2 db', 'hunter2'],
    ['tool --client-secret abc123 --github-token ghx1234', 'abc123'],
    ['tool --secret-key abc123', 'abc123'],
    ['DB_PASS=abc123', 'abc123'],
    ['MYSQL_PWD=abc123', 'abc123'],
    ['credentials: abc123', 'abc123'],
    ['AUTH_HEADER=abc123', 'abc123'],
    ['CLIENT_SECRET_VALUE=abc123', 'abc123'],
    ['Cookie: session=abc123; other=ok123', 'other=ok123'],
    ['Set-Cookie: sid=abc123', 'abc123'],
    ['auth_header: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['token: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['tool --authorization Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['auth_header: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['Authorization: Token abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['Proxy-Authorization: Negotiate abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
  ])('redacts %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  test.each([['bypass: true'], ['Tests pass: 12'], ['PWD=/Users/x/proj'], ['mkdir -p build/out'], ['git commit --pass-through x'], ['git commit --author "A B"'], ['tool --auth-url http://x --token-count 5 --secret-name n'], ['max_tokens: 100'], ['the passenger said hi']])('leaves %s alone', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

describe('redactSecrets: JSON-stringified secrets', () => {
  test.each([
    ['export TOKEN="abc123" && run', 'abc123'],
    ['echo password="hunter 2" x', 'hunter 2'],
    ['tool --password="hunter2"', 'hunter2'],
    ['mysql --password "hunter2" db', 'hunter2'],
    ['curl -u "admin:s3cr3t" https://x', 's3cr3t'],
    ["curl -u 'admin:s3cr3t' https://x", 's3cr3t'],
    ['curl -su admin:s3cr3t https://x', 's3cr3t'],
    ['curl https://x \\\n  -u admin:s3cr3t', 's3cr3t'],
    ['echo password=abc\\', 'abc'],
    ['set password=C:\\dir\\', 'C:'],
  ])('redacts and keeps %j parseable', (command, secret) => {
    const out = redactSecrets(JSON.stringify({ command }));

    expect(out).not.toContain(secret);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test.each([
    [{ Cookie: 'sid=abc123' }, 'abc123'],
    [{ Authorization: 'Bearer abc123' }, 'abc123'],
    [{ Authorization: 'ApiKey zzzsecret' }, 'zzzsecret'],
    [{ 'Set-Cookie': 'sid=abc123; Path=/' }, 'abc123'],
  ])('redacts the JSON-keyed header %j', (headers, secret) => {
    const out = redactSecrets(JSON.stringify(headers));

    expect(out).not.toContain(secret);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test.each([
    ['const cookie: string = getCookie();'],
    ['The Authorization: header carries the token.'],
    ['Set the Cookie: header on the request, then retry.'],
    ['headers: { authorization: `Bearer ${token}` }'],
    ['unauthorization: nothing here at all'],
    ['fetch(url, { credentials: "include" })'],
    ['credentials: true'],
  ])('leaves the prose or code %j alone', (input) => {
    expect(redactSecrets(input)).not.toContain('[REDACTED]');
  });
});

test('a scheme word after a keyword does not run on to the next line', () => {
  expect(redactSecrets('token: basic\nnext_key: value')).toContain('next_key: value');
});

test.each([[{ credentials: null, stream: true }], [{ credentials: { a: 1 }, x: 2 }], [{ token: [1, 2], secret_value: { a: 1 } }]])('leaves a non-scalar value after a keyword parseable: %j', (body) => {
  expect(() => JSON.parse(redactSecrets(JSON.stringify(body)))).not.toThrow();
});

describe('redactSecrets: JSON-stringified text and pathological input', () => {
  test.each([
    ['How do I read the cookie: header in express?'],
    ['curl -u admin:pw'],
    ['run: tool --password hunter2'],
    ['authorization: Token abcdefghijklmnop1234'],
  ])('keeps JSON parseable after redacting %s', (content) => {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content }], max_tokens: 100 });

    expect(() => JSON.parse(redactSecrets(body))).not.toThrow();
  });

  test.each([['curl -u "' + 'a'.repeat(100_000)], ['--password "'.repeat(10_000)], ['curl -u ' + '='.repeat(100_000)], ['curl --user=' + '='.repeat(100_000)], ['cookie:'.repeat(20_000)], ['--a-'.repeat(25_000)]])('stays fast on a long run of %#', (input) => {
    const started = Date.now();
    redactSecrets(input);

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('stays fast on a long run of repeated header labels with no closing dashes', () => {
    const started = Date.now();
    redactSecrets(`-----BEGIN ${'PRIVATE KEY '.repeat(12_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(redactSecrets('-----BEGIN ENCRYPTED PRIVATE KEY-----\nZmFrZQ==\n-----END ENCRYPTED PRIVATE KEY-----')).not.toContain('ZmFrZQ');
  });

  test.each([
    ['ghs_' + 'a'.repeat(36)],
    ['ghu_' + 'a'.repeat(36)],
    ['ghr_' + 'a'.repeat(36)],
    ['ASIA' + 'A1B2C3D4E5F6G7H8'],
    ['xapp-1-A0123456789-0123456789-abcdef'],
    ['SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43)],
    ['rk_live_' + 'a'.repeat(24)],
    ['whsec_' + 'a'.repeat(32)],
    ['redis://:hunter2hunter2@cache.internal:6379'],
    ['postgres://user:p@ss:word@db.internal/app'],
  ])('redacts %s', (secret) => {
    const out = redactSecrets(`value ${secret} end`);

    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(secret.slice(secret.length > 12 ? 6 : 0, secret.length - 2));
    expect(out).not.toContain('p@ss');
    expect(out).not.toContain('hunter2');
  });

  test('redacts a private key whose END marker is missing, and stays fast on unterminated headers', () => {
    expect(redactSecrets('head:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmU')).not.toContain('b3BlbnNz');

    const started = Date.now();
    redactSecrets('-----BEGIN PRIVATE KEY-----\n'.repeat(40_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

import { messageSize, rawMessageText, sanitizeBlock, sanitizeMessage, MAX_TURN_TEXT_CHARS } from '../../src/sessions/blocks.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

describe('sanitizeBlock', () => {
  it('keeps thinking text, drops its opaque signature, and caps it', () => {
    expect(sanitizeBlock({ type: 'thinking', thinking: 'I should run ls.', signature: 'A'.repeat(500) })).toEqual({ type: 'thinking', thinking: 'I should run ls.' });

    const long = sanitizeBlock({ type: 'thinking', thinking: 't'.repeat(10_000) }) as { thinking: string };
    expect(long.thinking.length).toBeLessThan(4_100);
    expect(long.thinking.endsWith('…[truncated]')).toBe(true);
  });

  it('leaves out empty or redacted thinking, redacted_thinking, and block types it does not know', () => {
    expect(sanitizeBlock({ type: 'thinking', thinking: '', signature: 'x' })).toBeUndefined();
    expect(sanitizeBlock({ type: 'redacted_thinking', data: 'encrypted' })).toBeUndefined();
    expect(sanitizeBlock({ type: 'server_tool_use', name: 'web_search' })).toBeUndefined();
    expect(sanitizeBlock({ type: 'image', source: {} })).toBeUndefined();
    expect(sanitizeBlock('not a block')).toBeUndefined();
  });

  it('redacts secrets in thinking, text, tool inputs and tool results', () => {
    const blocks = [
      sanitizeBlock({ type: 'thinking', thinking: `the key is ${SECRET}` }),
      sanitizeBlock({ type: 'text', text: `use ${SECRET}` }),
      sanitizeBlock({ type: 'tool_use', id: 't', name: 'Bash', input: { command: `curl -H "x-api-key: ${SECRET}"`, nested: { env: [`KEY=${SECRET}`] } } }),
      sanitizeBlock({ type: 'tool_result', tool_use_id: 't', content: `OUT ${SECRET}` }),
    ];
    expect(JSON.stringify(blocks)).not.toContain(SECRET);
    expect(JSON.stringify(blocks)).toContain('[REDACTED]');
  });

  it('redacts BEFORE capping: a secret that straddles the cap is never left half-visible', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(100).slice(0, 1_990);
    const content = `${filler}${SECRET} ${'and then some more words '.repeat(20)}`; // the secret begins 10 characters before the 2,000 cap
    const block = sanitizeBlock({ type: 'tool_result', tool_use_id: 't', content }) as { content: string };

    expect(block.content).not.toMatch(/sk-ant|abcdefghij/);
    expect(block.content).toContain('lorem ipsum'); // only the secret went, not the surrounding text
    expect(block.content.endsWith('…[truncated]')).toBe(true);
  });

  it('redacts the value of a secret-named field of a tool input, however plain the value looks', () => {
    const block = sanitizeBlock({
      type: 'tool_use',
      name: 'browser_type',
      input: { username: 'qa-user', password: 'hunter2xyz', headers: { authorization: 'abcdef123' }, env: { API_KEY: 'plainvalue' }, creds: [{ cookie: 'sessionvalue' }], max_tokens: 1024 },
    }) as { input: Record<string, unknown> };
    const json = JSON.stringify(block.input);

    expect(json).not.toMatch(/hunter2xyz|abcdef123|plainvalue|sessionvalue/);
    expect(block.input.username).toBe('qa-user');
    expect(block.input.max_tokens).toBe(1024);
  });

  it('treats a {name, value} pair as a secret by its name, and tells secret names from look-alikes', () => {
    const block = sanitizeBlock({
      type: 'tool_use',
      name: 'http',
      input: { headers: [{ name: 'Authorization', value: 'abc123' }, { name: 'Accept', value: 'json' }], pwd: 'p4ss', author_name: 'Ada', max_tokens_to_sample: 5, secretary: 'Bo' },
    }) as { input: { headers: Array<{ value: string }> } & Record<string, unknown> };

    expect(block.input.headers[0].value).toBe('[REDACTED]');
    expect(block.input.headers[1].value).toBe('json');
    expect(block.input.pwd).toBe('[REDACTED]');
    expect([block.input.author_name, block.input.max_tokens_to_sample, block.input.secretary]).toEqual(['Ada', 5, 'Bo']);
  });

  it('redacts plural and compound secret names, but not numeric limits', () => {
    const block = sanitizeBlock({
      type: 'tool_use',
      name: 'T',
      input: { tokens: ['abcdef1234', 'zzz'], api_tokens: 'plainsecret', accessTokens: 'plain2', pass: 'plain3', env: [{ variable: 'API_KEY', val: 'plain6' }, { key: 'MY_SECRET', value: 'plain7' }, { header: 'Cookie', value: 'plain8' }], max_tokens: 100, output_tokens: 7 },
    }) as { input: unknown };
    const json = JSON.stringify(block.input);

    expect(json).not.toMatch(/abcdef1234|zzz|plainsecret|plain2|plain3|plain6|plain7|plain8/);
    expect(json).toContain('"max_tokens":100');
    expect(json).toContain('"output_tokens":7');
  });

  it('redacts a secret given as a command-line flag, in a command string or an argument array', () => {
    const block = sanitizeBlock({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'mysql --password hunter2 && psql --token abcdef123 db; curl -u admin:s3cr3t https://x', args: ['--password', 'hunter3', '--verbose', 'yes'] },
    }) as { input: { command: string; args: string[] } };

    expect(JSON.stringify(block.input)).not.toMatch(/hunter2|hunter3|abcdef123|s3cr3t/);
    expect(block.input.command).toContain('mysql --password [REDACTED]');
    expect(block.input.args).toEqual(['--password', '[REDACTED]', '--verbose', 'yes']);
  });

  it('keeps keys that collide after trimming from corrupting the object, and drops a padded __proto__', () => {
    const block = sanitizeBlock({ type: 'tool_use', name: 'T', input: JSON.parse('{" __proto__ ": 1, "ok": 2}') }) as { input: Record<string, unknown> };

    expect(Object.keys(block.input)).toEqual(['ok']);
    expect(Object.getPrototypeOf(block.input)).toBe(Object.prototype);
  });

  it('does not mistake ordinary words for secret names', () => {
    const block = sanitizeBlock({ type: 'tool_use', name: 'T', input: { compass: 'north', bypass_cache: 'yes', authored_by: 'Ada', pass: 'p4ss' } }) as { input: Record<string, unknown> };

    expect(block.input).toEqual({ compass: 'north', bypass_cache: 'yes', authored_by: 'Ada', pass: '[REDACTED]' });
  });

  it('caps the ids a block carries', () => {
    const block = sanitizeBlock({ type: 'tool_use', id: 'i'.repeat(5_000), name: 'T', input: {} }) as { id: string };

    expect(block.id).toHaveLength(200);
  });

  it('redacts and caps the keys of a tool input too', () => {
    const block = sanitizeBlock({ type: 'tool_use', name: 'T', input: { [`${SECRET}${'k'.repeat(5_000)}`]: 1 } }) as { input: Record<string, unknown> };
    const [key] = Object.keys(block.input);

    expect(key).not.toContain('abcdefghij');
    expect(key.length).toBeLessThan(300);
  });

  it('never leaves part of a secret behind when redaction shrinks the text before a window cut', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(40)}\n-----END RSA PRIVATE KEY-----\n`;
    const prose = 'plain prose words '.repeat(80);
    const text = `${pem.repeat(200)}${prose.repeat(100)}${pem}`; // long enough to be cut at the redaction window
    const block = sanitizeBlock({ type: 'tool_result', tool_use_id: 't', content: text }) as { content: string };

    expect(block.content).not.toContain('BEGIN RSA');
    expect(block.content).not.toContain('QUJDREVG');
  });

  it('marks a text block cut at the cap, and keeps one under the cap whole', () => {
    const words = 'plain prose words '.repeat(Math.ceil((MAX_TURN_TEXT_CHARS * 0.7) / 18));
    const under = sanitizeBlock({ type: 'text', text: words }) as { text: string };
    const over = sanitizeBlock({ type: 'text', text: `${words}${words}` }) as { text: string };

    expect(under.text.endsWith('…[truncated]')).toBe(false);
    expect(under.text.length).toBeGreaterThan(60_000);
    expect(over.text.endsWith('…[truncated]')).toBe(true);
  });

  it('does not mark text as truncated when only redaction made it shorter', () => {
    const text = `${'plain prose words '.repeat(100)}${SECRET}`;
    const block = sanitizeBlock({ type: 'tool_result', tool_use_id: 't', content: text.padEnd(1_990, ' ') + 'tail words' }) as { content: string };

    expect(block.content.endsWith('…[truncated]')).toBe(false);
  });

  it('keeps a tool call as name, id and input, with long strings capped and the shape bounded', () => {
    const block = sanitizeBlock({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Write',
      input: { file_path: '/tmp/x', content: 'c'.repeat(10_000), list: Array.from({ length: 200 }, (_, i) => i), deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } },
    }) as { name: string; id: string; input: Record<string, unknown> };

    expect(block).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'Write' });
    expect(block.input.file_path).toBe('/tmp/x');
    expect((block.input.content as string).length).toBeLessThan(2_100);
    expect(block.input.list).toHaveLength(50);
    expect(JSON.stringify(block.input.deep)).toContain('…[truncated]');
  });

  it('flattens a tool result to text, with images as a placeholder, caps it, and keeps is_error', () => {
    expect(sanitizeBlock({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'line' }, { type: 'image', source: {} }], is_error: true })).toEqual({
      type: 'tool_result',
      tool_use_id: 't',
      content: 'line\n[image]',
      is_error: true,
    });
    const big = sanitizeBlock({ type: 'tool_result', tool_use_id: 't', content: 'r'.repeat(700_000) }) as { content: string };
    expect(big.content.length).toBeLessThan(2_100);
  });

  it('does not copy prototype-pollution keys out of a tool input', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "ok": 2}');
    const block = sanitizeBlock({ type: 'tool_use', name: 'X', input }) as { input: Record<string, unknown> };
    expect(Object.keys(block.input)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('sanitizeMessage', () => {
  it('sends an assistant message that is one text block as a plain string', () => {
    expect(sanitizeMessage({ role: 'assistant', blocks: [{ type: 'text', text: 'hello' }] })).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('keeps the blocks, in order, of anything richer', () => {
    const message = sanitizeMessage({
      role: 'assistant',
      blocks: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }],
    });
    expect(message).toEqual({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }],
    });
  });

  it('is undefined when nothing survives', () => {
    expect(sanitizeMessage({ role: 'assistant', blocks: [{ type: 'redacted_thinking', data: 'x' }] })).toBeUndefined();
  });
});

describe('messageSize and rawMessageText', () => {
  it('sizes a message by what would be kept, without redacting', () => {
    expect(messageSize({ role: 'user', blocks: [{ type: 'tool_result', content: 'x'.repeat(50_000) }] })).toBeLessThan(2_200);
    expect(messageSize({ role: 'assistant', blocks: [{ type: 'text', text: 'y'.repeat(MAX_TURN_TEXT_CHARS + 5) }] })).toBe(MAX_TURN_TEXT_CHARS);
  });

  it('sizes a tool call by its capped input, not its raw input', () => {
    const input = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v'.repeat(5_000)]));
    const size = messageSize({ role: 'assistant', blocks: [{ type: 'tool_use', name: 'T', input }] });

    expect(size).toBeGreaterThan(50 * 2_000);
    expect(size).toBeLessThan(50 * 2_100);
  });

  it('reads the text of a message from its text blocks only', () => {
    expect(rawMessageText({ role: 'assistant', blocks: [{ type: 'thinking', thinking: 'no' }, { type: 'text', text: 'one' }, { type: 'tool_use', name: 'X' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo');
  });
});

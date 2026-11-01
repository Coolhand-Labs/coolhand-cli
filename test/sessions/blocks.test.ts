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

  it('reads the text of a message from its text blocks only', () => {
    expect(rawMessageText({ role: 'assistant', blocks: [{ type: 'thinking', thinking: 'no' }, { type: 'text', text: 'one' }, { type: 'tool_use', name: 'X' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo');
  });
});

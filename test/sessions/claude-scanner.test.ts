import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { parseTranscript, scanSessions, sessionIdOf } from '../../src/sessions/claude-scanner.js';
import type { SessionFileMeta } from '../../src/sessions/session-filter.js';

const SAMPLE = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'First question' } }),
  JSON.stringify({
    type: 'assistant',
    requestId: 'req_1',
    message: {
      role: 'assistant',
      id: 'msg_1',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'First answer.' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    },
  }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Second question' } }),
  JSON.stringify({
    type: 'assistant',
    requestId: 'req_2',
    message: {
      role: 'assistant',
      id: 'msg_2',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'Second answer.' }],
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3 },
    },
  }),
].join('\n');

describe('parseTranscript', () => {
  test('builds one envelope for the whole session', () => {
    const env = parseTranscript(SAMPLE, 'sess-1');
    expect(env).not.toBeNull();
  });

  test('uses a session-level claudecode url (no per-turn id)', () => {
    const env = parseTranscript(SAMPLE, 'sess-1');
    expect(env?.url).toBe('claudecode://session/sess-1');
  });

  test('carries the full conversation in request_body.messages', () => {
    const env = parseTranscript(SAMPLE, 'sess-1');
    expect(env?.request_body.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer.' },
    ]);
  });

  test('response_body is the final assistant turn', () => {
    const env = parseTranscript(SAMPLE, 'sess-1');
    expect(env?.response_body.id).toBe('req_2');
    expect(env?.response_body.content).toEqual([{ type: 'text', text: 'Second answer.' }]);
    expect(env?.response_body.model).toBe('claude-opus-4-8');
  });

  test('sums token usage across all turns', () => {
    const env = parseTranscript(SAMPLE, 'sess-1');
    expect(env?.response_body.usage).toEqual({
      input_tokens: 30,
      output_tokens: 12,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    });
  });

  test('counts one turn per assistant response', () => {
    const env = parseTranscript(SAMPLE, 'sess-1');
    expect(env?.turnCount).toBe(2);
  });

  test('a single-assistant transcript has turnCount 1', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', id: 'm', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(parseTranscript(line, 's')?.turnCount).toBe(1);
  });

  test('returns null when the session has no assistant turns', () => {
    const onlyUser = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(parseTranscript(onlyUser, 'sess-1')).toBeNull();
  });

  test('falls back to message.id when requestId is missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', id: 'msg_x', content: [{ type: 'text', text: 'hi' }] },
    });
    const env = parseTranscript(line, 's');
    expect(env?.response_body.id).toBe('msg_x');
  });

  test('falls back to the session id when a turn has no id at all', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    const env = parseTranscript(line, 'sess-9');
    expect(env?.response_body.id).toBe('sess-9');
  });

  test('ignores blank and unparseable lines', () => {
    const text = `\n  \nnot json\n${SAMPLE}`;
    const env = parseTranscript(text, 'sess-1');
    expect(env?.request_body.messages).toHaveLength(4);
  });

  test('captures projectPath from the first line carrying a non-empty cwd', () => {
    const lines = [
      JSON.stringify({ type: 'user', cwd: '/Users/me/repo', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        cwd: '/Users/me/repo',
        message: { role: 'assistant', id: 'm', content: [{ type: 'text', text: 'hi' }] },
      }),
    ].join('\n');
    expect(parseTranscript(lines, 's')?.projectPath).toBe('/Users/me/repo');
  });

  test('projectPath is undefined when no line has a cwd', () => {
    expect(parseTranscript(SAMPLE, 'sess-1')?.projectPath).toBeUndefined();
  });

  test('projectPath is undefined and parsing does not throw when cwd is malformed', () => {
    const lines = [
      JSON.stringify({ type: 'user', cwd: 42, message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'user', cwd: '   ', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', id: 'm', content: [{ type: 'text', text: 'hi' }] },
      }),
    ].join('\n');
    expect(() => parseTranscript(lines, 's')).not.toThrow();
    expect(parseTranscript(lines, 's')?.projectPath).toBeUndefined();
  });
});

describe('parseTranscript — tool activity & block rendering', () => {
  const assistantLine = (content: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'assistant',
      requestId: 'r',
      message: { role: 'assistant', id: 'm', content, ...extra },
    });

  test('serialises a tool_use block with its name and input', () => {
    const env = parseTranscript(
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }]),
      's'
    );
    expect(env?.request_body.messages[0].content).toBe('[tool_use: Bash] {"command":"ls -la"}');
  });

  test('tool_use with no input omits the payload', () => {
    const env = parseTranscript(assistantLine([{ type: 'tool_use', name: 'Read' }]), 's');
    expect(env?.request_body.messages[0].content).toBe('[tool_use: Read]');
  });

  test('renders a tool_result whose content is a plain string', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
    });
    // A user-only transcript has no assistant turn, so pair it with one to get an envelope.
    const env = parseTranscript(`${line}\n${assistantLine([{ type: 'text', text: 'done' }])}`, 's');
    expect(env?.request_body.messages[0].content).toBe('[tool_result] file.txt');
  });

  test('renders a tool_result whose content is a block array (no [object Object])', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'nested output' }] }],
      },
    });
    const env = parseTranscript(`${line}\n${assistantLine([{ type: 'text', text: 'done' }])}`, 's');
    expect(env?.request_body.messages[0].content).toBe('[tool_result] nested output');
    expect(env?.request_body.messages[0].content).not.toContain('[object Object]');
  });

  test('flags an errored tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
    });
    const env = parseTranscript(`${line}\n${assistantLine([{ type: 'text', text: 'done' }])}`, 's');
    expect(env?.request_body.messages[0].content).toBe('[tool_result:error] boom');
  });

  test('renders an image block as a placeholder, never its payload', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
    });
    const env = parseTranscript(`${line}\n${assistantLine([{ type: 'text', text: 'done' }])}`, 's');
    expect(env?.request_body.messages[0].content).toBe('[image]');
    expect(env?.request_body.messages[0].content).not.toContain('AAAA');
  });

  test('keeps both text and tool_use from a single turn, in order', () => {
    const env = parseTranscript(
      assistantLine([
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'foo' } },
      ]),
      's'
    );
    expect(env?.request_body.messages[0].content).toBe('Let me check.\n[tool_use: Grep] {"pattern":"foo"}');
  });

  test('drops thinking blocks but still counts the turn', () => {
    const env = parseTranscript(assistantLine([{ type: 'thinking', thinking: 'secret reasoning' }]), 's');
    expect(env).not.toBeNull();
    expect(env?.turnCount).toBe(1);
    expect(env?.request_body.messages).toHaveLength(0);
    expect(JSON.stringify(env)).not.toContain('secret reasoning');
  });

  test('drops unknown block types safely', () => {
    const env = parseTranscript(
      assistantLine([{ type: 'mystery', data: 'x' }, { type: 'text', text: 'hi' }]),
      's'
    );
    expect(env?.request_body.messages[0].content).toBe('hi');
  });

  test('does not throw on a null block inside the content array', () => {
    const env = parseTranscript(assistantLine([null, { type: 'text', text: 'hi' }]), 's');
    expect(env?.request_body.messages[0].content).toBe('hi');
  });

  test('truncates an oversized tool input', () => {
    const big = 'x'.repeat(5000);
    const env = parseTranscript(assistantLine([{ type: 'tool_use', name: 'Write', input: { content: big } }]), 's');
    const rendered = env?.request_body.messages[0].content ?? '';
    expect(rendered.length).toBeLessThan(3000);
    expect(rendered).toContain('…[truncated]');
  });

  test('redacts secrets in tool output before capture', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OPENAI_API_KEY=sk-abcdef1234567890ABCDEF' }],
      },
    });
    const env = parseTranscript(`${line}\n${assistantLine([{ type: 'text', text: 'done' }])}`, 's');
    const rendered = env?.request_body.messages[0].content ?? '';
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('sk-abcdef1234567890ABCDEF');
  });
});

describe('parseTranscript — multi-line turn dedup', () => {
  // One assistant turn (requestId r1) split across two lines, repeating identical usage.
  const MULTILINE = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({
      type: 'assistant',
      requestId: 'r1',
      message: {
        role: 'assistant',
        id: 'm1',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Running it.' }],
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 20 },
      },
    }),
    JSON.stringify({
      type: 'assistant',
      requestId: 'r1',
      message: {
        role: 'assistant',
        id: 'm1',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 20 },
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      requestId: 'r2',
      message: {
        role: 'assistant',
        id: 'm2',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
      },
    }),
  ].join('\n');

  test('counts each requestId once despite spanning multiple lines', () => {
    expect(parseTranscript(MULTILINE, 's')?.turnCount).toBe(2);
  });

  test('sums usage once per turn, including cache_creation', () => {
    expect(parseTranscript(MULTILINE, 's')?.response_body.usage).toEqual({
      input_tokens: 150,
      output_tokens: 18,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 20,
    });
  });

  test('merges the split lines of one turn into a single assistant message', () => {
    const env = parseTranscript(MULTILINE, 's');
    expect(env?.request_body.messages).toEqual([
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'Running it.\n[tool_use: Bash] {"command":"ls"}' },
      { role: 'user', content: '[tool_result] file.txt' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

describe('parseTranscript — review hardening', () => {
  test('redacts a secret even when it sits past the truncation boundary', () => {
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'r',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Write', input: { content: 'x'.repeat(2100) + 'sk-abcdef1234567890ABCDEF' } },
        ],
      },
    });
    const env = parseTranscript(line, 's');
    const rendered = env?.request_body.messages[0].content ?? '';
    expect(rendered).not.toContain('sk-abcdef1234567890ABCDEF');
  });

  test('two id-less turns merge into one message (documented approximation)', () => {
    const l1 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } });
    const l2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } });
    const env = parseTranscript(l1 + '\n' + l2, 'sess');
    expect(env?.turnCount).toBe(1);
    expect(env?.request_body.messages).toEqual([{ role: 'assistant', content: 'one\ntwo' }]);
  });
});

describe('sessionIdOf', () => {
  test('returns the session id from a session envelope', () => {
    const env = parseTranscript(SAMPLE, 'sess-42');
    expect(sessionIdOf(env!)).toBe('sess-42');
  });
});

describe('scanSessions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `chs-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(path.join(dir, 'proj-a'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('returns empty when the projects dir does not exist', async () => {
    const res = await scanSessions({ projectsDir: path.join(dir, 'missing') });
    expect(res).toEqual({ envelopes: [], sessionCount: 0, filteredOut: 0, ok: true });
  });

  test('produces one envelope per session file', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'sess-1.jsonl'), SAMPLE);
    await fs.writeFile(path.join(dir, 'proj-a', 'sess-2.jsonl'), SAMPLE);
    const res = await scanSessions({ projectsDir: dir });
    expect(res.sessionCount).toBe(2);
    expect(res.envelopes).toHaveLength(2);
  });

  test('uses the filename as the session id in the url', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'my-session.jsonl'), SAMPLE);
    const res = await scanSessions({ projectsDir: dir });
    expect(res.envelopes[0].url).toBe('claudecode://session/my-session');
  });

  test('skips a session file that has no assistant turns', async () => {
    const onlyUser = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    await fs.writeFile(path.join(dir, 'proj-a', 'empty.jsonl'), onlyUser);
    const res = await scanSessions({ projectsDir: dir });
    expect(res.sessionCount).toBe(1);
    expect(res.envelopes).toHaveLength(0);
  });

  test('sinceTime skips files older than the cutoff and reads newer ones', async () => {
    const oldFile = path.join(dir, 'proj-a', 'old.jsonl');
    const newFile = path.join(dir, 'proj-a', 'new.jsonl');
    await fs.writeFile(oldFile, SAMPLE);
    await fs.writeFile(newFile, SAMPLE);

    const cutoff = new Date('2026-06-10T00:00:00.000Z');
    const past = new Date('2026-06-01T00:00:00.000Z');
    const future = new Date('2026-06-20T00:00:00.000Z');
    await fs.utimes(oldFile, past, past);
    await fs.utimes(newFile, future, future);

    const res = await scanSessions({ projectsDir: dir, sinceTime: cutoff });
    // Only the future-mtime file is examined; "scanned" reflects work done this run.
    expect(res.sessionCount).toBe(1);
    expect(res.envelopes).toHaveLength(1);
    expect(res.envelopes[0].url).toBe('claudecode://session/new');
  });

  test('sinceTime includes a file whose mtime equals the cutoff', async () => {
    const file = path.join(dir, 'proj-a', 'edge.jsonl');
    await fs.writeFile(file, SAMPLE);
    const cutoff = new Date('2026-06-10T00:00:00.000Z');
    await fs.utimes(file, cutoff, cutoff);

    const res = await scanSessions({ projectsDir: dir, sinceTime: cutoff });
    expect(res.envelopes).toHaveLength(1);
  });

  test('reports filteredOut 0 when no preFilter is given', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'sess-1.jsonl'), SAMPLE);
    const res = await scanSessions({ projectsDir: dir });
    expect(res.filteredOut).toBe(0);
  });

  test('a rejected file is counted as filteredOut and never read from disk', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'private.jsonl'), SAMPLE);
    const readSpy = jest.spyOn(fs, 'readFile');
    try {
      const res = await scanSessions({ projectsDir: dir, preFilter: () => false });
      expect(res.envelopes).toHaveLength(0);
      expect(res.sessionCount).toBe(0);
      expect(res.filteredOut).toBe(1);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  test('preFilter receives the session id, project folder, mtime, and source', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'sess-1.jsonl'), SAMPLE);
    const seen: SessionFileMeta[] = [];
    await scanSessions({
      projectsDir: dir,
      preFilter: (meta) => {
        seen.push(meta);
        return true;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe('sess-1');
    expect(seen[0].project).toBe('proj-a');
    expect(seen[0].source).toBe('claude-code');
    expect(seen[0].mtimeMs).toBeGreaterThan(0);
  });

  test('preFilter accepting keeps the session in the result', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'sess-1.jsonl'), SAMPLE);
    const res = await scanSessions({ projectsDir: dir, preFilter: () => true });
    expect(res.envelopes).toHaveLength(1);
    expect(res.filteredOut).toBe(0);
  });
});

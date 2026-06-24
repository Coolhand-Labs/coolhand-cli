import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { parseTranscript, scanSessions, sessionIdOf } from '../../src/sessions/claude-scanner.js';

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
    expect(res).toEqual({ envelopes: [], sessionCount: 0 });
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
});

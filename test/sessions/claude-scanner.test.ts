import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { parseTranscript, scanSessions } from '../../src/sessions/claude-scanner.js';

const SAMPLE = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Refactor this function' } }),
  JSON.stringify({
    type: 'assistant',
    requestId: 'req_abc123',
    message: {
      role: 'assistant',
      id: 'msg_1',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }),
].join('\n');

describe('parseTranscript', () => {
  test('builds one envelope per assistant turn', () => {
    expect(parseTranscript(SAMPLE, 'sess-1')).toHaveLength(1);
  });

  test('sets the claudecode url from session and request id', () => {
    const [env] = parseTranscript(SAMPLE, 'sess-1');
    expect(env.url).toBe('claudecode://session/sess-1/req_abc123');
  });

  test('uses requestId as the response_body.id dedup key', () => {
    const [env] = parseTranscript(SAMPLE, 'sess-1');
    expect(env.response_body.id).toBe('req_abc123');
  });

  test('attaches the preceding user message as the user prompt', () => {
    const [env] = parseTranscript(SAMPLE, 'sess-1');
    expect(env.request_body.messages[0]).toEqual({ role: 'user', content: 'Refactor this function' });
  });

  test('carries model, content and usage into response_body', () => {
    const [env] = parseTranscript(SAMPLE, 'sess-1');
    expect(env.response_body.model).toBe('claude-opus-4-8');
    expect(env.response_body.content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(env.response_body.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test('falls back to message.id when requestId is missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', id: 'msg_x', content: [] },
    });
    const [env] = parseTranscript(line, 's');
    expect(env.response_body.id).toBe('msg_x');
  });

  test('skips assistant turns with no usable id', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } });
    expect(parseTranscript(line, 's')).toHaveLength(0);
  });

  test('ignores blank and unparseable lines', () => {
    const text = `\n  \nnot json\n${SAMPLE}`;
    expect(parseTranscript(text, 'sess-1')).toHaveLength(1);
  });

  test('extracts user text from a content block array', () => {
    const text = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Block prompt' }] },
      }),
      JSON.stringify({ type: 'assistant', requestId: 'r', message: { role: 'assistant', content: [] } }),
    ].join('\n');
    const [env] = parseTranscript(text, 's');
    expect(env.request_body.messages[0].content).toBe('Block prompt');
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

  test('reads .jsonl files and counts sessions', async () => {
    await fs.writeFile(path.join(dir, 'proj-a', 'sess-1.jsonl'), SAMPLE);
    const res = await scanSessions({ projectsDir: dir });
    expect(res.sessionCount).toBe(1);
    expect(res.envelopes).toHaveLength(1);
    expect(res.envelopes[0].response_body.id).toBe('req_abc123');
  });

  test('uses the filename as the fallback session id', async () => {
    const line = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { role: 'assistant', content: [] } });
    await fs.writeFile(path.join(dir, 'proj-a', 'my-session.jsonl'), line);
    const res = await scanSessions({ projectsDir: dir });
    expect(res.envelopes[0].url).toBe('claudecode://session/my-session/r1');
  });
});

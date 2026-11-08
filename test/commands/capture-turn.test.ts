import http from 'http';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AddressInfo } from 'net';
import { run } from '../../src/commands/capture-turn.js';
import { replaySpooledTurns, sendTurn } from '../../src/hooks/send-turn.js';
import { loadTurnState, saveTurnState } from '../../src/hooks/turn-state.js';
import { countPending, listTurnFiles, readPendingRecord, savePendingRecord } from '../../src/pending-store.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';
import { events } from '../helpers/copilot-transcript.js';

/**
 * No SDK mock: a local HTTP server stands in for Coolhand, so these tests prove what actually goes
 * over the wire — the public key header, the per-turn envelope, the metadata — end to end.
 */

const INGEST_PATH = '/api/v2/llm_request_logs';
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

interface Received {
  apiKey: string | undefined;
  body: Record<string, any>;
}
interface FakeCoolhand {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

async function startFakeCoolhand(status = 200, okBody: object = { id: 1 }): Promise<FakeCoolhand> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === INGEST_PATH) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ apiKey: req.headers['x-api-key'] as string | undefined, body: JSON.parse(body) });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status < 300 ? okBody : { error: 'boom' }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const TRANSCRIPT = [
  { type: 'user', message: { role: 'user', content: 'Run the login QA checklist' }, cwd: '/tmp/proj' },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'INJECTED SKILL BODY' } },
  {
    type: 'assistant',
    requestId: 'r1',
    message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file.txt' }] } },
  {
    type: 'assistant',
    requestId: 'r2',
    message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Checklist done.' }] },
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

describe('capture-turn', () => {
  let home: TmpHome;
  let server: FakeCoolhand;
  let transcriptPath: string;
  const savedEnv = { ...process.env };

  const stop = (overrides: Record<string, unknown> = {}) => ({
    hook_event_name: 'Stop',
    session_id: 'sess-1',
    transcript_path: transcriptPath,
    cwd: '/tmp/proj',
    last_assistant_message: `Checklist done. token=${SECRET}`,
    stop_hook_active: false,
    ...overrides,
  });
  const opts = () => ({ agent: 'claude' as const, skill: 'qa-login', apiKey: 'pk_test_123', baseUrl: server.url });

  beforeEach(async () => {
    home = await createTmpHome();
    server = await startFakeCoolhand();
    transcriptPath = path.join(home.dir, 'transcript.jsonl');
    await fs.writeFile(transcriptPath, TRANSCRIPT);
    process.env.COOLHAND_CAPTURE_USER = 'tester@example.com';
    delete process.env.COOLHAND_API_KEY;
    delete process.env.COOLHAND_CAPTURE_DISABLED; // a developer who disabled capture must still be able to run these
  });

  afterEach(async () => {
    await server.close();
    await home.cleanup();
    // Restore in place: replacing process.env with a plain object loses its string coercion.
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it("sends the turn's conversation (prompt, thinking-free tool loop, reply) with the public key, but never injected context or secrets", async () => {
    const code = await run(opts(), { readInput: async () => stop({ last_assistant_message: `Checklist done.` }) });

    expect(code).toBe(0);
    expect(server.received).toHaveLength(1);
    const { apiKey, body } = server.received[0];
    expect(apiKey).toBe('pk_test_123');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('INJECTED SKILL BODY'); // the skill body the harness injects is not a message
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('coolhand-hook://claude/session/sess-1/turn/1');
    expect(raw).toContain('sess-1:1');
    expect(raw).toContain('tester@example.com');
    expect(raw).toContain('qa-login');

    const request = body.llm_request_log.raw_request;
    // The tool loop is part of the conversation: the call, then its result, as structured blocks.
    expect(request.request_body.messages).toEqual([
      { role: 'user', content: 'Run the login QA checklist' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file.txt' }] },
    ]);
    expect(request.response_body.content).toEqual([{ type: 'text', text: 'Checklist done.' }]);
  });

  it('numbers successive turns and does not resend an identical turn', async () => {
    await run(opts(), { readInput: async () => stop() });
    await run(opts(), { readInput: async () => stop() }); // same turn fired twice
    await run(opts(), { readInput: async () => stop({ last_assistant_message: 'A different answer' }) });

    expect(server.received).toHaveLength(2);
    expect(JSON.stringify(server.received[1].body)).toContain('sess-1:2');
  });

  it('falls back to COOLHAND_API_KEY and sends nothing without any key', async () => {
    process.env.COOLHAND_API_KEY = 'pk_from_env';
    await run({ agent: 'claude', baseUrl: server.url }, { readInput: async () => stop() });
    expect(server.received[0].apiKey).toBe('pk_from_env');

    delete process.env.COOLHAND_API_KEY;
    await run({ agent: 'claude', baseUrl: server.url }, { readInput: async () => stop({ session_id: 'sess-2' }) });
    expect(server.received).toHaveLength(1);
  });

  it('still captures the turn when the transcript is unreadable, without the user half', async () => {
    await run(opts(), { readInput: async () => stop({ transcript_path: '/nonexistent/t.jsonl' }) });

    expect(server.received).toHaveLength(1);
    expect(server.received[0].body.llm_request_log.raw_request.request_body.messages).toEqual([]);
  });

  it('ignores other events, empty input and payloads without a session or message', async () => {
    await run(opts(), { readInput: async () => stop({ hook_event_name: 'UserPromptSubmit' }) });
    await run(opts(), { readInput: async () => null });
    await run(opts(), { readInput: async () => stop({ session_id: undefined }) });
    await run(opts(), { readInput: async () => stop({ last_assistant_message: '', transcript_path: undefined }) });

    expect(server.received).toHaveLength(0);
  });

  it('exits 0 and spools the turn when the server refuses it, then drops it once a newer turn of the session is sent', async () => {
    await server.close();
    server = await startFakeCoolhand(500);

    const code = await run(opts(), { readInput: async () => stop() });
    expect(code).toBe(0);
    expect(await listTurnFiles()).toHaveLength(1);
    expect(await countPending()).toBe(0); // hook turns don't count as user-facing pending records
    const record = await readPendingRecord((await listTurnFiles())[0]);
    expect(record.kind).toBe('turn');
    expect(record.apiKey).toBe('pk_test_123');
    expect(record.ambiguous).toBeUndefined(); // a quick refusal: the server did not take it

    // Same port is gone; bring up a healthy server and point the next turn at it.
    await server.close();
    server = await startFakeCoolhand(200);
    const spooledFile = (await listTurnFiles())[0];
    const spooled = await fs.readFile(spooledFile, 'utf8');
    await fs.writeFile(spooledFile, spooled.replace(/"baseUrl": ".*"/, `"baseUrl": "${server.url}"`));

    await run(opts(), { readInput: async () => stop({ last_assistant_message: 'Next turn' }) });
    // Turn 2 carries everything turn 1 said and the server keeps only a session's newest turn, so the
    // spooled turn 1 is discarded rather than replayed.
    expect(await listTurnFiles()).toHaveLength(0);
    expect(server.received).toHaveLength(1);
    expect(JSON.stringify(server.received[0].body)).toContain('/turn/2');
  });

  const transcriptWith = async (requestId: string) => {
    const file = path.join(home.dir, `t-${requestId}.jsonl`);
    const lines = [
      { type: 'user', message: { role: 'user', content: 'continue' } },
      { type: 'assistant', requestId, message: { id: `m-${requestId}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ];
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
  };

  it('sends two genuinely identical turns, but not one turn whose hook fired twice', async () => {
    const first = await transcriptWith('req-1');
    const second = await transcriptWith('req-2');
    const turn = (file: string) => stop({ transcript_path: file, last_assistant_message: 'Done.' });

    await run(opts(), { readInput: async () => turn(first) });
    await run(opts(), { readInput: async () => turn(first) }); // double fire
    await run(opts(), { readInput: async () => turn(second) }); // same words, a new model call

    expect(server.received).toHaveLength(2);
  });

  it('--anonymous beats COOLHAND_CAPTURE_USER and leaves out the working directory', async () => {
    await run({ ...opts(), anonymous: true }, { readInput: async () => stop() });

    const raw = JSON.stringify(server.received[0].body);
    expect(raw).not.toContain('tester@example.com');
    expect(raw).not.toContain('/tmp/proj');
    expect(raw).toContain('"tester_source":"machine"');
  });

  it('keeps one tester per session even if the environment changes mid-session', async () => {
    await run(opts(), { readInput: async () => stop() });
    process.env.COOLHAND_CAPTURE_USER = 'someone-else@example.com';
    await run(opts(), { readInput: async () => stop({ last_assistant_message: 'next' }) });

    expect(JSON.stringify(server.received[1].body)).toContain('tester@example.com');
  });

  describe('the spool', () => {
    const spoolTurn = (name: string, text: string, baseUrl: string) =>
      savePendingRecord({
        command: 'capture-turn',
        kind: 'turn',
        payload: {
          envelope: { url: `coolhand-hook://claude/session/${name}/turn/1`, request_body: { messages: [] }, response_body: { id: name, content: [{ type: 'text', text }] } },
          collector: 'test',
          metadata: {},
        },
        apiKey: 'pk_test_123',
        baseUrl,
        savedAt: new Date().toISOString(),
      });

    it('replays past a record the server keeps refusing', async () => {
      await server.close();
      // Refuse anything mentioning POISON, accept the rest.
      const received: string[] = [];
      const picky = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const poisoned = body.includes('POISON');
          if (!poisoned) {
            received.push(body);
          }
          res.writeHead(poisoned ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end('{"id":1}');
        });
      });
      await new Promise<void>((resolve) => picky.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(picky.address() as AddressInfo).port}`;
      try {
        await spoolTurn('a-poison', 'POISON', url);
        await new Promise((r) => setTimeout(r, 5)); // filenames sort oldest-first by timestamp
        await spoolTurn('b-good', 'fine', url);

        await run({ ...opts(), baseUrl: url }, { readInput: async () => stop() });

        const left = await Promise.all((await listTurnFiles()).map((f) => fs.readFile(f, 'utf8')));
        expect(left).toHaveLength(1);
        expect(left[0]).toContain('POISON');
        expect(received.some((b) => b.includes('fine'))).toBe(true);
      } finally {
        await new Promise<void>((resolve) => picky.close(() => resolve()));
        server = await startFakeCoolhand();
      }
    });

    it('reaches newer turns even when several older records are permanently refused', async () => {
      await server.close();
      const received: string[] = [];
      const picky = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const poisoned = body.includes('POISON');
          if (!poisoned) {
            received.push(body);
          }
          res.writeHead(poisoned ? 401 : 200, { 'Content-Type': 'application/json' });
          res.end('{"id":1}');
        });
      });
      await new Promise<void>((resolve) => picky.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(picky.address() as AddressInfo).port}`;
      try {
        for (const name of ['p1', 'p2', 'p3', 'p4']) {
          await spoolTurn(name, 'POISON', url);
          await new Promise((r) => setTimeout(r, 5));
        }
        await spoolTurn('newer-good', 'recent turn', url);

        await run({ ...opts(), baseUrl: url }, { readInput: async () => stop() });

        expect(received.some((b) => b.includes('recent turn'))).toBe(true);
      } finally {
        await new Promise<void>((resolve) => picky.close(() => resolve()));
        server = await startFakeCoolhand();
      }
    });

    it('survives a malformed spooled record and still replays the good one behind it', async () => {
      await savePendingRecord({
        command: 'capture-turn',
        kind: 'turn',
        payload: { nothing: 'useful' }, // no envelope
        apiKey: 'pk_test_123',
        baseUrl: server.url,
        savedAt: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 5));
      await spoolTurn('good-after-bad', 'still delivered', server.url);

      await run(opts(), { readInput: async () => stop() });

      expect(server.received.some((r) => JSON.stringify(r.body).includes('still delivered'))).toBe(true);
    });

    it('stops replaying once the total time budget is spent', async () => {
      for (let i = 0; i < 5; i++) {
        await spoolTurn(`budget-${i}`, `queued-${i}`, server.url);
        await new Promise((r) => setTimeout(r, 3));
      }
      // The clock jumps a minute as soon as the first replayed record has reached the server.
      const realNow = Date.now.bind(Date);
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + (server.received.length >= 2 ? 60_000 : 0));
      try {
        await run(opts(), { readInput: async () => stop() });
      } finally {
        clock.mockRestore();
      }

      expect(server.received).toHaveLength(2); // the new turn plus one replayed record
      expect(await listTurnFiles()).toHaveLength(4);
    });

    it('drops a spooled turn after three failed replays instead of retrying (and duplicating) it forever', async () => {
      await server.close();
      const picky = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(body.includes('POISON') ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end('{"id":1}');
        });
      });
      await new Promise<void>((resolve) => picky.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(picky.address() as AddressInfo).port}`;
      try {
        await spoolTurn('always-refused', 'POISON', url);
        const left = async () => (await listTurnFiles()).length;

        for (const [i, expected] of [[1, 1], [2, 1], [3, 0]] as const) {
          await run({ ...opts(), baseUrl: url }, { readInput: async () => stop({ last_assistant_message: `turn ${i}` }) });
          expect(await left()).toBe(expected);
          if (expected === 1) {
            // The count is on disk as soon as the upload starts, so a killed hook still uses an attempt up.
            expect((await readPendingRecord((await listTurnFiles())[0])).attempts).toBe(i);
          }
        }
        // Dropping a turn is data loss, so it is on record where the docs say to look.
        const log = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
        expect(log).toContain('gave up on spooled turn');
      } finally {
        await new Promise<void>((resolve) => picky.close(() => resolve()));
        server = await startFakeCoolhand();
      }
    });

    it('delivers a spooled turn once when two hook runs replay at the same time', async () => {
      await spoolTurn('contended', 'only-once-please', server.url);

      await Promise.all([replaySpooledTurns(), replaySpooledTurns()]);

      const hits = server.received.filter((r) => JSON.stringify(r.body).includes('only-once-please'));
      expect(hits).toHaveLength(1);
      expect(await listTurnFiles()).toHaveLength(0);
    });

    it('does not let a second run take over a claim whose record is old and still uploading', async () => {
      await server.close();
      let hits = 0;
      const slow = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (body.includes('old-but-once')) {
            hits += 1;
          }
          // Hold the upload open so the second run starts while the first still owns the claim.
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"id":1}');
          }, 400);
        });
      });
      await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
      try {
        // Spooled minutes ago: rename keeps that mtime, which must not make the claim look abandoned.
        const file = await spoolTurn('old-contended', 'old-but-once', url);
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        await fs.utimes(file, tenMinutesAgo, tenMinutesAgo);

        const first = replaySpooledTurns();
        // Start the second run only once the first really holds the claim (not after a fixed sleep).
        const pending = path.dirname(file);
        for (let i = 0; i < 200 && !(await fs.readdir(pending)).some((n) => n.endsWith('.claim')); i++) {
          await new Promise((r) => setTimeout(r, 15));
        }
        expect((await fs.readdir(pending)).some((n) => n.endsWith('.claim'))).toBe(true);
        await replaySpooledTurns();
        await first;

        expect(hits).toBe(1);
      } finally {
        await new Promise<void>((resolve) => slow.close(() => resolve()));
        server = await startFakeCoolhand();
      }
    });

    it('removes a temp file left behind by a process that died while rewriting a claim', async () => {
      const dir = path.dirname(await spoolTurn('anchor', 'anchor', server.url));
      const leftover = path.join(dir, '.capture-turn-x.json.claim.deadbeef.tmp');
      await fs.writeFile(leftover, '{}');
      const longAgo = new Date(Date.now() - 5 * 60 * 1000);
      await fs.utimes(leftover, longAgo, longAgo);

      await replaySpooledTurns();

      await expect(fs.access(leftover)).rejects.toThrow();
    });

    it('hands back a claim left behind by a process that died mid-replay', async () => {
      const file = await spoolTurn('orphaned', 'rescued', server.url);
      await fs.rename(file, `${file}.claim`);
      const longAgo = new Date(Date.now() - 5 * 60 * 1000);
      await fs.utimes(`${file}.claim`, longAgo, longAgo);

      await replaySpooledTurns();

      expect(server.received.some((r) => JSON.stringify(r.body).includes('rescued'))).toBe(true);
    });

    it('marks replayed turns so consumers can tell them from first sends', async () => {
      await spoolTurn('marked', 'replay-me', server.url);

      await replaySpooledTurns();

      const raw = server.received.find((r) => JSON.stringify(r.body).includes('replay-me'))!.body.llm_request_log;
      expect(raw.metadata).toMatchObject({ replayed: true, replay_attempt: 1 });
    });

    it('discards a spooled file that is not a record at all, and keeps going', async () => {
      const dir = path.dirname(await spoolTurn('anchor', 'anchor-delivered', server.url));
      await fs.writeFile(path.join(dir, `capture-turn-${new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, '-')}-ffff.json`), 'null');

      await replaySpooledTurns();

      expect(await listTurnFiles()).toHaveLength(0);
      expect(server.received.some((r) => JSON.stringify(r.body).includes('anchor-delivered'))).toBe(true);
    });

    it('still replays when this session\'s state cannot be saved', async () => {
      await spoolTurn('state-broken', 'replayed-anyway', server.url);
      // Make the state directory impossible to create: a plain file sits where it should be.
      await fs.writeFile(path.join(home.dir, 'capture-turns'), 'in the way');

      const code = await run(opts(), { readInput: async () => stop() });

      expect(code).toBe(0);
      expect(server.received.some((r) => JSON.stringify(r.body).includes('replayed-anyway'))).toBe(true);
    });

    it('flags the replay of a timed-out send as a possible duplicate, and only that', async () => {
      const ambiguousFile = await spoolTurn('timed-out', 'ambiguous-one', server.url);
      const raw = JSON.parse(await fs.readFile(ambiguousFile, 'utf8'));
      await fs.writeFile(ambiguousFile, JSON.stringify({ ...raw, ambiguous: true }));
      await new Promise((r) => setTimeout(r, 5));
      await spoolTurn('refused', 'refused-one', server.url);

      await replaySpooledTurns();

      const meta = (needle: string) =>
        server.received.find((r) => JSON.stringify(r.body).includes(needle))!.body.llm_request_log.metadata;
      expect(meta('ambiguous-one')).toMatchObject({ replayed: true, possible_duplicate: true });
      expect(meta('refused-one').possible_duplicate).toBeUndefined();
    });

    it('flags a record as a possible duplicate once one of its replays runs out the clock', async () => {
      await server.close();
      const hang = http.createServer(() => {
        // Never respond.
      });
      await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
      try {
        await spoolTurn('slow-replay', 'maybe-stored', url); // first refused quickly: not flagged
        expect((await readPendingRecord((await listTurnFiles())[0])).ambiguous).toBeUndefined();

        await replaySpooledTurns(200);

        const record = await readPendingRecord((await listTurnFiles())[0]);
        expect(record.attempts).toBe(1);
        expect(record.ambiguous).toBe(true);
      } finally {
        hang.closeAllConnections();
        await new Promise<void>((resolve) => hang.close(() => resolve()));
        server = await startFakeCoolhand();
      }
    });

    it('does not make a further attempt on a record that has already used all of them', async () => {
      const file = await spoolTurn('exhausted', 'must-not-be-sent', server.url);
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...raw, attempts: 3 }));

      await replaySpooledTurns();

      expect(server.received.some((r) => JSON.stringify(r.body).includes('must-not-be-sent'))).toBe(false);
      expect(await listTurnFiles()).toHaveLength(0);
    });

    it('replays even when config.json is unreadable, because the record carries its own key', async () => {
      await fs.writeFile(path.join(home.dir, 'config.json'), '{ not json');
      await spoolTurn('c-ok', 'queued', server.url);

      await run(opts(), { readInput: async () => stop() });

      expect(await listTurnFiles()).toHaveLength(0);
      expect(server.received.some((r) => JSON.stringify(r.body).includes('queued'))).toBe(true);
    });

    it('drops week-old turns and caps the spool when a new turn has to be saved', async () => {
      await server.close();
      server = await startFakeCoolhand(500);
      const old = await spoolTurn('old', 'old', server.url);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await fs.utimes(old, eightDaysAgo, eightDaysAgo);
      for (let i = 0; i < 205; i++) {
        await spoolTurn(`bulk-${i}`, 'x', server.url);
      }

      await run(opts(), { readInput: async () => stop() }); // fails -> spools -> prunes

      const files = await listTurnFiles();
      expect(files).toHaveLength(200);
      expect(files).not.toContain(old);
    });
  });

  it('writes nothing to stdout or stderr even when the server rejects the key', async () => {
    await server.close();
    server = await startFakeCoolhand(401);
    // The console stubs are shared by the whole file; count only what this run does.
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      (console[method] as jest.Mock).mockClear();
    }
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await run(opts(), { readInput: async () => stop() });

      expect(code).toBe(0);
      // coolhand-node logs request failures with console.error whatever `silent` says.
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        expect(console[method]).not.toHaveBeenCalled();
      }
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('stamps every turn with a stable turn_id equal to the response id', async () => {
    await run(opts(), { readInput: async () => stop() });

    const { llm_request_log: log } = server.received[0].body;
    expect(log.metadata.turn_id).toBe(log.raw_request.response_body.id);
    expect(log.metadata.replayed).toBeUndefined();
  });

  it.each(['1', 'true', 'YES'])('COOLHAND_CAPTURE_DISABLED=%s sends nothing and reads nothing', async (value) => {
    process.env.COOLHAND_CAPTURE_DISABLED = value;
    const readInput = jest.fn(async () => stop());

    const code = await run(opts(), { readInput });

    expect(code).toBe(0);
    expect(readInput).not.toHaveBeenCalled();
    expect(server.received).toHaveLength(0);
  });

  it('records a lost turn and still advances the session when the send fails and the spool is unwritable', async () => {
    await server.close();
    server = await startFakeCoolhand(500);
    await fs.writeFile(path.join(home.dir, 'pending'), 'a file where the spool directory should be');

    const code = await run(opts(), { readInput: async () => stop() });

    expect(code).toBe(0);
    const log = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
    expect(log).toContain('could not be sent or spooled');

    await server.close();
    server = await startFakeCoolhand(200);
    await run({ ...opts(), baseUrl: server.url }, { readInput: async () => stop({ last_assistant_message: 'the next turn' }) });
    expect(JSON.stringify(server.received[0].body)).toContain('/turn/2');
  });

  describe('the conversation so far', () => {
    type Ex = { u: string; a: string };
    /** Exchange `i` was written `i` seconds into the session. */
    const ts = (i: number) => `2026-10-28T10:00:${String(i).padStart(2, '0')}.000Z`;
    const write = async (name: string, exchanges: Ex[]) => {
      const file = path.join(home.dir, `${name}.jsonl`);
      const lines = exchanges.flatMap((e, i) => [
        { type: 'user', timestamp: ts(i), message: { role: 'user', content: e.u } },
        { type: 'assistant', requestId: `${name}-${i}`, message: { id: `${name}-m${i}`, role: 'assistant', content: [{ type: 'text', text: e.a }] } },
      ]);
      await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
      return file;
    };
    const sent = (i: number) => server.received[i].body.llm_request_log;

    it("turn 2 carries turn 1's user and assistant text, ends on turn 2's user message, and replies with turn 2's answer", async () => {
      const t1 = await write('t1', [{ u: 'what is 2+2?', a: 'four' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t1, last_assistant_message: 'four' }) });
      const t2 = await write('t2', [{ u: 'what is 2+2?', a: 'four' }, { u: 'and times three?', a: 'twelve' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t2, last_assistant_message: 'twelve' }) });

      expect(sent(0).raw_request.request_body.messages).toEqual([{ role: 'user', content: 'what is 2+2?' }]);
      const second = sent(1).raw_request;
      expect(second.request_body.messages).toEqual([
        { role: 'user', content: 'what is 2+2?' },
        { role: 'assistant', content: 'four' },
        { role: 'user', content: 'and times three?' },
      ]);
      expect(second.response_body.content).toEqual([{ type: 'text', text: 'twelve' }]);
      expect(second.url).toBe('coolhand-hook://claude/session/sess-1/turn/2');
      expect(sent(1).metadata).toMatchObject({ session_id: 'sess-1', turn_index: 2 });
      expect(sent(1).metadata.history_truncated).toBeUndefined();
    });

    it('leaves out everything said before the skill was invoked, on a later turn too', async () => {
      const t = await write('pre', [
        { u: 'my private question', a: 'a private answer' },
        { u: '/qa-login', a: 'starting the checklist' },
        { u: 'first step', a: 'done' },
      ]);
      await saveTurnState('claude', 'sess-1', { turnIndex: 1, lastDigest: 'x', anchor: ts(1), captured: [ts(1)] });
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'done' }) });

      expect(JSON.stringify(sent(0))).not.toContain('private');
      expect(sent(0).raw_request.request_body.messages.map((m: { content: string }) => m.content)).toEqual([
        '/qa-login', 'starting the checklist', 'first step',
      ]);
    });

    it('stays out of it when the first captured turn is the only one: turn 1 carries no history at all', async () => {
      const t = await write('pre1', [{ u: 'my private question', a: 'a private answer' }, { u: '/qa-login', a: 'starting' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'starting' }) });

      expect(JSON.stringify(sent(0))).not.toContain('private');
      expect(sent(0).raw_request.request_body.messages).toEqual([{ role: 'user', content: '/qa-login' }]);
    });

    it('while the transcript lags, a turn is not recorded as captured, and the next turn flags the gap instead of sending it', async () => {
      const t1 = await write('lag-1', [{ u: '/qa-login', a: 'start' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t1, last_assistant_message: 'start' }) });

      // Turn 2: the hook fires before the transcript shows this turn's prompt or reply.
      await run(opts(), { readInput: async () => stop({ transcript_path: t1, last_assistant_message: 'the second reply' }) });
      expect((await loadTurnState('claude', 'sess-1')).captured).toEqual([ts(0)]); // exchange 2 is not claimed as captured

      // Turn 3: the transcript has caught up and shows exchange 2 as an answered exchange nobody captured.
      const t3 = await write('lag-3', [{ u: '/qa-login', a: 'start' }, { u: 'second prompt', a: 'the second reply' }, { u: 'third prompt', a: 'third reply' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t3, last_assistant_message: 'third reply' }) });

      const third = sent(2);
      expect(third.raw_request.request_body.messages.map((m: { content: string }) => m.content)).toEqual(['/qa-login', 'start', 'third prompt']);
      expect(third.metadata.history_truncated).toBe(true);
    });

    it('a repeated reply while the transcript lags is the same turn: nothing new is sent and nothing is claimed as captured', async () => {
      const t = await write('repeat', [{ u: 'continue', a: 'Done.' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'Done.' }) });
      const before = await loadTurnState('claude', 'sess-1');

      // A second "continue" -> "Done." whose exchange isn't in the transcript yet looks exactly like the first.
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'Done.' }) });

      expect(server.received).toHaveLength(1);
      expect(await loadTurnState('claude', 'sess-1')).toEqual(before);
    });

    it('a spooled turn carries the same cumulative payload it was built with', async () => {
      await server.close();
      server = await startFakeCoolhand(500);
      await saveTurnState('claude', 'sess-1', { turnIndex: 1, lastDigest: 'x', anchor: ts(0), captured: [ts(0)] });
      const t = await write('spool', [{ u: 'first', a: 'one' }, { u: 'second', a: 'two' }]);

      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'two' }) });

      const record = await readPendingRecord((await listTurnFiles())[0]);
      const payload = record.payload as { envelope: { request_body: { messages: unknown[] }; url: string } };
      expect(payload.envelope.url).toMatch(/\/turn\/2$/);
      expect(payload.envelope.request_body.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'second' },
      ]);
    });

    it('does not upload /compact output or other command output, and keeps every captured turn', async () => {
      const file = path.join(home.dir, 'compact.jsonl');
      const line = (o: unknown) => JSON.stringify(o);
      await fs.writeFile(
        file,
        [
          line({ type: 'user', timestamp: ts(0), message: { role: 'user', content: 'before the skill' } }),
          line({ type: 'assistant', requestId: 'p0', message: { id: 'p0', role: 'assistant', content: [{ type: 'text', text: 'private reply' }] } }),
          line({ type: 'user', timestamp: ts(1), message: { role: 'user', content: '/qa-login' } }),
          line({ type: 'assistant', requestId: 'a1', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'checklist started' }] } }),
          line({ type: 'user', timestamp: ts(2), message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } }),
          line({ type: 'user', timestamp: ts(3), message: { role: 'user', content: '<local-command-stdout>Compacted: someone@example.com</local-command-stdout>' } }),
          line({ type: 'user', timestamp: ts(4), message: { role: 'user', content: 'next step' } }),
          line({ type: 'assistant', requestId: 'a2', message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
        ].join('\n')
      );
      // The checklist start was captured (turn 1); this is turn 2.
      await saveTurnState('claude', 'sess-1', { turnIndex: 1, lastDigest: 'x', anchor: ts(1), captured: [ts(1)] });

      await run(opts(), { readInput: async () => stop({ transcript_path: file, last_assistant_message: 'done' }) });

      const messages = sent(0).raw_request.request_body.messages.map((m: { content: string }) => m.content);
      // `/compact` was typed but is no turn (no reply to capture), so it is not part of the history.
      expect(messages).toEqual(['/qa-login', 'checklist started', 'next step']);
      expect(JSON.stringify(sent(0))).not.toMatch(/private|someone@example|Compacted/);
    });

    it('never uploads what was typed while capture was off, and says there is a gap', async () => {
      const t1 = await write('off-1', [{ u: '/qa-login', a: 'start' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t1, last_assistant_message: 'start' }) });

      // The user turns capture off (or resumes the session) and works privately; no hook runs for exchange 1.
      const t3 = await write('off-3', [
        { u: '/qa-login', a: 'start' },
        { u: 'private work done while nothing was captured', a: 'a private answer' },
        { u: 'back on the checklist', a: 'continuing' },
      ]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t3, last_assistant_message: 'continuing' }) });

      const second = sent(1);
      expect(JSON.stringify(second.raw_request.request_body)).not.toMatch(/private/);
      expect(second.raw_request.request_body.messages.map((m: { content: string }) => m.content)).toEqual(['/qa-login', 'start', 'back on the checklist']);
      expect(second.metadata.history_truncated).toBe(true);
    });

    it("records each captured exchange in the session's state", async () => {
      const t = await write('record', [{ u: '/qa-login', a: 'go' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'go' }) });
      expect((await loadTurnState('claude', 'sess-1')).captured).toEqual([ts(0)]);
    });

    it('keeps flagging history as truncated for the rest of a session whose anchor had to be seeded late', async () => {
      await saveTurnState('claude', 'sess-1', { turnIndex: 1, lastDigest: 'x' }); // a session with no anchor, past turn 1
      const t = await write('late', [{ u: 'a', a: 'b' }, { u: 'c', a: 'd' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'd' }) });
      const t2 = await write('late2', [{ u: 'a', a: 'b' }, { u: 'c', a: 'd' }, { u: 'e', a: 'f' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t2, last_assistant_message: 'f' }) });

      expect(sent(0).metadata.history_truncated).toBe(true);
      expect(sent(1).metadata.history_truncated).toBe(true); // the conversation still starts at the seeded anchor, not at turn 1
      expect((await loadTurnState('claude', 'sess-1')).anchorLate).toBe(true);
    });

    it('remembers where the skill started, so the anchor is saved on the first captured turn', async () => {
      const t = await write('anchor', [{ u: 'earlier chat', a: 'x' }, { u: '/qa-login', a: 'go' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'go' }) });

      expect((await loadTurnState('claude', 'sess-1')).anchor).toBe(ts(1));
    });

    it('sends no history, flagged, for a session past turn 1 whose state has no anchor, and starts one', async () => {
      await saveTurnState('claude', 'sess-1', { turnIndex: 2, lastDigest: 'x' });
      const t = await write('noanchor', [{ u: 'old', a: 'old reply' }, { u: 'current', a: 'now' }]);

      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'now' }) });

      expect(sent(0).raw_request.request_body.messages).toEqual([{ role: 'user', content: 'current' }]);
      expect(sent(0).metadata.history_truncated).toBe(true);
      expect((await loadTurnState('claude', 'sess-1')).anchor).toBe(ts(1));
    });

    it("drops a session's older spooled turns only once a newer one has been delivered, and leaves other sessions and legacy files alone", async () => {
      await server.close();
      server = await startFakeCoolhand(500);
      for (const i of [1, 2]) {
        const t = await write(`spool-${i}`, Array.from({ length: i }, (_, k) => ({ u: `q${k + 1}`, a: `a${k + 1}` })));
        await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: `reply ${i}` }) });
      }
      await run(opts(), { readInput: async () => stop({ session_id: 'other-session', last_assistant_message: 'unrelated' }) });
      const legacy = await savePendingRecord({ command: 'capture-turn', kind: 'turn', payload: {}, apiKey: 'pk', baseUrl: server.url, savedAt: new Date().toISOString() });

      // A newer turn that is only spooled does not take its predecessors with it: it could still be refused.
      const names = (await listTurnFiles()).map((f) => path.basename(f));
      expect(names.filter((n) => /\.s[0-9a-f]{10}-t[12]\.json$/.test(n))).toHaveLength(3); // sess-1 t1, t2 and other-session t1

      await server.close();
      server = await startFakeCoolhand(200);
      for (const file of await listTurnFiles()) {
        const text = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, text.replace(/"baseUrl": ".*"/, `"baseUrl": "${server.url}"`));
      }
      const t3 = await write('spool-3', [1, 2, 3].map((k) => ({ u: `q${k}`, a: `a${k}` })));
      await run({ ...opts(), baseUrl: server.url }, { readInput: async () => stop({ transcript_path: t3, last_assistant_message: 'a3' }) });

      const urls = server.received.map((r) => r.body.llm_request_log.raw_request.url as string);
      expect(urls).toContain('coolhand-hook://claude/session/sess-1/turn/3');
      expect(urls).toContain('coolhand-hook://claude/session/other-session/turn/1'); // another session is still replayed
      expect(urls.filter((u) => /\/session\/sess-1\/turn\/[12]$/.test(u))).toHaveLength(0); // superseded: never sent
      // The legacy (untagged) file was neither discarded as superseded nor mistaken for a newer turn; it
      // carries an empty payload, so its replay fails and it is left for its own attempts to retire.
      expect((await listTurnFiles()).map((f) => path.basename(f))).toEqual([path.basename(legacy)]);
    });

    it('does not discard a higher-numbered spooled turn because a lower-numbered one was sent (restarted numbering)', async () => {
      const tag = `s${createHash('sha1').update('sess-1').digest('hex').slice(0, 10)}-t30`;
      const higher = await savePendingRecord({ command: 'capture-turn', kind: 'turn', payload: {}, apiKey: 'pk', baseUrl: 'http://127.0.0.1:9', fileTag: tag, savedAt: new Date().toISOString() });

      await run(opts(), { readInput: async () => stop() }); // sess-1 starts again at turn 1 and is delivered

      expect(await fs.stat(higher).then(() => true, () => false)).toBe(true);
    });

    it('keeps the spool under its size cap by dropping the oldest records', async () => {
      await server.close();
      server = await startFakeCoolhand(500);
      const big = 'b'.repeat(25 * 1024 * 1024);
      for (let i = 0; i < 3; i++) {
        await savePendingRecord({
          command: 'capture-turn',
          kind: 'turn',
          payload: { blob: big },
          apiKey: 'pk_test_123',
          baseUrl: server.url,
          savedAt: new Date(Date.now() + i).toISOString(),
        });
      }
      expect(await listTurnFiles()).toHaveLength(3);

      await run(opts(), { readInput: async () => stop() }); // fails -> spools -> prunes

      const sizes = await Promise.all((await listTurnFiles()).map(async (f) => (await fs.stat(f)).size));
      expect(sizes.filter((n) => n > 20 * 1024 * 1024)).toHaveLength(2); // the oldest big one is gone
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(64 * 1024 * 1024 + 1024 * 1024);
    }, 60000);

    it('says when the oldest history was left out to stay inside the size cap', async () => {
      const big = 'w'.repeat(90_000);
      const t = await write('big', [1, 2, 3, 4].map((n) => ({ u: `${n}${big}`, a: `${n}${big}` })).concat([{ u: 'latest', a: 'reply' }]));
      await saveTurnState('claude', 'sess-1', { turnIndex: 4, lastDigest: 'x', anchor: ts(0), captured: [ts(0), ts(1), ts(2), ts(3)] });

      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'reply' }) });

      const { metadata, raw_request: raw } = sent(0);
      expect(metadata).toMatchObject({ turn_index: 5, history_truncated: true });
      expect(metadata.history_omitted).toBeGreaterThan(0);
      expect(raw.request_body.messages[raw.request_body.messages.length - 1]).toEqual({ role: 'user', content: 'latest' });
    });
  });

  describe('workload, skill text and token usage', () => {
    const ts = (i: number) => `2026-10-28T10:00:${String(i).padStart(2, '0')}.000Z`;
    const tokens = (n: number) => ({ input_tokens: n, output_tokens: n * 2, cache_read_input_tokens: n * 10, cache_creation_input_tokens: n * 3 });
    const SKILL_BODY = '# QA login\nWalk through the login checklist.';
    type Ex = { u: string; a: string; usage?: number; skill?: string; agents?: Array<{ id: string; model: string }> };
    const write = async (name: string, exchanges: Ex[]) => {
      const file = path.join(home.dir, `${name}.jsonl`);
      const out: unknown[] = [];
      exchanges.forEach((e, i) => {
        out.push({ type: 'user', timestamp: ts(i), message: { role: 'user', content: e.u } });
        if (e.skill) {
          out.push({ type: 'user', isMeta: true, timestamp: ts(i), message: { role: 'user', content: `Base directory for this skill: /Users/me/.claude/skills/${e.skill}\n\n${SKILL_BODY}` } });
        }
        for (const agent of e.agents ?? []) {
          out.push({
            type: 'user',
            timestamp: ts(i),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agent.id, content: 'report' }] },
            toolUseResult: { status: 'completed', agentId: agent.id, resolvedModel: agent.model, usage: tokens(1) },
          });
        }
        out.push({
          type: 'assistant',
          requestId: `${name}-${i}`,
          timestamp: ts(i),
          message: { id: `${name}-m${i}`, role: 'assistant', content: [{ type: 'text', text: e.a }], ...(e.usage ? { usage: tokens(e.usage) } : {}) },
        });
      });
      await fs.writeFile(file, out.map((l) => JSON.stringify(l)).join('\n'));
      return file;
    };
    const log = (i: number) => server.received[i].body.llm_request_log;

    it('declares one workload per skill, with no template, when --skill is given', async () => {
      await run(opts(), { readInput: async () => stop() });

      expect(log(0).declared).toEqual({
        reporter: 'coolhand-cli',
        workload: { key: 'claude-skill:qa-login', name: 'qa-login' },
      });
      expect(log(0).declared.template).toBeUndefined();
    });

    it('with a --skill pattern, a session-wide hook sends only sessions that invoked a matching skill, under that skill', async () => {
      const mine = await write('mine', [{ u: '/qa-login', a: 'started', skill: 'qa-login' }]);
      const other = await write('other', [{ u: '/deploy', a: 'deployed', skill: 'deploy' }]);
      const plain = await write('plain', [{ u: 'what is 2+2?', a: '4' }]);
      const hook = (name: string, transcript: string) => stop({ session_id: name, transcript_path: transcript, last_assistant_message: undefined });

      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => hook('s-other', other) });
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => hook('s-plain', plain) });
      expect(server.received).toHaveLength(0);

      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => hook('s-mine', mine) });
      expect(server.received).toHaveLength(1);
      expect(log(0).metadata.skill).toBe('qa-login');
      expect(log(0).declared.workload.key).toBe('claude-skill:qa-login');
      expect(JSON.stringify(server.received)).toContain('Walk through the login checklist.');

      // `*` takes any skill, and still never records the pattern as the skill's name.
      await run({ ...opts(), skill: '*' }, { readInput: async () => hook('s-other', other) });
      expect(log(1).metadata.skill).toBe('deploy');
      expect(JSON.stringify(server.received)).not.toContain('claude-skill:*');
    });

    it('with a --skill list of alternatives, a prefix pattern and an exact name both count, under the skill that matched', async () => {
      const prefixed = await write('prefixed', [{ u: '/qa-login', a: 'started', skill: 'qa-login' }]);
      const exact = await write('exact', [{ u: '/skill-for-qas', a: 'started', skill: 'skill-for-qas' }]);
      const other = await write('other2', [{ u: '/deploy', a: 'deployed', skill: 'deploy' }]);
      const hook = (name: string, transcript: string) => stop({ session_id: name, transcript_path: transcript, last_assistant_message: undefined });
      const skill = 'qa-*|skill-for-qas';

      await run({ ...opts(), skill }, { readInput: async () => hook('s-other2', other) });
      expect(server.received).toHaveLength(0);

      await run({ ...opts(), skill }, { readInput: async () => hook('s-prefixed', prefixed) });
      await run({ ...opts(), skill }, { readInput: async () => hook('s-exact', exact) });
      expect(server.received).toHaveLength(2);
      expect(log(0).metadata.skill).toBe('qa-login');
      expect(log(1).metadata.skill).toBe('skill-for-qas');
      expect(JSON.stringify(server.received)).not.toContain('qa-*|skill-for-qas');
    });

    it('with a --skill pattern, a skill the MODEL loaded (no slash command) never makes a session count', async () => {
      const model = await write('model', [{ u: 'please run the login checks', a: 'ok', skill: 'qa-login' }]);
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop({ session_id: 's-model', transcript_path: model, last_assistant_message: undefined }) });
      await run({ ...opts(), skill: '*' }, { readInput: async () => stop({ session_id: 's-model', transcript_path: model, last_assistant_message: undefined }) });
      expect(server.received).toHaveLength(0);
    });

    it("with a --skill pattern, a plugin skill's namespaced command (/plugin:skill) counts, under the skill's folder name", async () => {
      const plugin = await write('plugin', [{ u: '/coolhand-qa:qa-spike go', a: 'started', skill: 'qa-spike' }]);
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop({ session_id: 's-plugin', transcript_path: plugin, last_assistant_message: undefined }) });
      expect(server.received).toHaveLength(1);
      expect(log(0).metadata.skill).toBe('qa-spike');
    });

    it('with a --skill pattern, a session stays on its skill after the invocation has left the transcript window', async () => {
      const first = await write('first', [{ u: '/qa-login', a: 'started', skill: 'qa-login' }]);
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop({ session_id: 's-long', transcript_path: first, last_assistant_message: undefined }) });
      // Later: the transcript window no longer shows the invocation (or any skill).
      const later = await write('later', [{ u: 'and the next step?', a: 'next step done' }]);
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop({ session_id: 's-long', transcript_path: later, last_assistant_message: undefined }) });

      expect(server.received).toHaveLength(2);
      expect(log(1).metadata).toMatchObject({ skill: 'qa-login', turn_index: 2 });
      expect(log(1).declared.workload.key).toBe('claude-skill:qa-login');
      // A pin from another entry whose pattern does not match is ignored.
      await run({ ...opts(), skill: 'other-*' }, { readInput: async () => stop({ session_id: 's-long', transcript_path: later, last_assistant_message: undefined }) });
      expect(server.received).toHaveLength(2);
    });

    it('with a --skill list of alternatives, a pin from an earlier entry counts only if the list still matches it', async () => {
      const first = await write('list-first', [{ u: '/qa-login', a: 'started', skill: 'qa-login' }]);
      // The later window shows a different skill, so only the pin check decides whether the session stays on qa-login.
      const later = await write('list-later', [{ u: '/deploy', a: 'deployed', skill: 'deploy' }]);
      const hook = (transcript: string) => stop({ session_id: 's-list', transcript_path: transcript, last_assistant_message: undefined });
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => hook(first) });
      // A list whose exact name is the pinned skill still captures the later turn.
      await run({ ...opts(), skill: 'other-*|qa-login' }, { readInput: async () => hook(later) });
      expect(server.received).toHaveLength(2);
      expect(log(1).metadata).toMatchObject({ skill: 'qa-login', turn_index: 2 });
      // A list that no longer matches the pin ignores it. The window has new text, so a wrongly honoured pin would send
      // a fresh turn rather than being dropped as a duplicate of the one already sent.
      const newer = await write('list-newer', [{ u: '/deploy', a: 'deployed again', skill: 'deploy' }]);
      await run({ ...opts(), skill: 'other-*|nope' }, { readInput: async () => hook(newer) });
      expect(server.received).toHaveLength(2);
      await run({ ...opts(), skill: 'other-*|qa-login' }, { readInput: async () => hook(newer) });
      expect(server.received).toHaveLength(3);
    });

    it('with a --skill pattern and an unreadable transcript, sends nothing', async () => {
      await run({ ...opts(), skill: '*' }, { readInput: async () => stop({ session_id: 's-gone', transcript_path: path.join(home.dir, 'missing.jsonl') }) });
      expect(server.received).toHaveLength(0);
    });

    it('with a --skill pattern, a Claude session stays on the first skill it resolved to when a later command invokes another', async () => {
      const both = await write('both', [
        { u: '/qa-login', a: 'started', skill: 'qa-login' },
        { u: '/qa-checkout', a: 'second skill', skill: 'qa-checkout' },
      ]);
      const hook = () => stop({ session_id: 's-two', transcript_path: both, last_assistant_message: undefined });
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => hook() });
      expect(log(0).metadata.skill).toBe('qa-login');
      expect(log(0).declared.workload.key).toBe('claude-skill:qa-login');
    });

    it('with a --skill pattern, a pinned session is still captured when its transcript cannot be read', async () => {
      const first = await write('pin-first', [{ u: '/qa-login', a: 'started', skill: 'qa-login' }]);
      await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop({ session_id: 's-pin', transcript_path: first, last_assistant_message: undefined }) });
      await run(
        { ...opts(), skill: 'qa-*' },
        { readInput: async () => stop({ session_id: 's-pin', transcript_path: path.join(home.dir, 'gone.jsonl'), last_assistant_message: 'a later reply' }) }
      );
      expect(server.received).toHaveLength(2);
      expect(log(1).metadata).toMatchObject({ skill: 'qa-login', turn_index: 2 });
    });

    it("keeps the pinned skill in the session's state file, capped at 200 characters and ignored when not a string", async () => {
      await saveTurnState('claude', 'pin-state', { turnIndex: 1, skill: 'x'.repeat(300) });
      expect((await loadTurnState('claude', 'pin-state')).skill).toBe('x'.repeat(200));
      await saveTurnState('claude', 'pin-state-2', { turnIndex: 1, skill: 'qa-login' });
      expect((await loadTurnState('claude', 'pin-state-2')).skill).toBe('qa-login');
      await saveTurnState('claude', 'pin-state-3', { turnIndex: 1 });
      expect((await loadTurnState('claude', 'pin-state-3')).skill).toBeUndefined();
    });

    it('uses the same workload key on every turn and session of a skill, a different one for another skill, and never sends a template', async () => {
      await run(opts(), { readInput: async () => stop({ session_id: 'session-a' }) });
      await run(opts(), { readInput: async () => stop({ session_id: 'session-a', last_assistant_message: 'a later turn' }) });
      await run(opts(), { readInput: async () => stop({ session_id: 'session-b' }) });
      await run({ ...opts(), skill: 'qa-checkout' }, { readInput: async () => stop({ session_id: 'session-c' }) });

      const keys = [0, 1, 2, 3].map((i) => log(i).declared.workload.key);
      expect(keys).toEqual(['claude-skill:qa-login', 'claude-skill:qa-login', 'claude-skill:qa-login', 'claude-skill:qa-checkout']);
      for (let i = 0; i < 4; i++) {
        expect(Object.keys(log(i).declared).sort()).toEqual(['reporter', 'workload']);
        expect(JSON.stringify(log(i).declared)).not.toMatch(/template/i);
      }
    });

    it('sends metadata.skill_version only when --skill-version is given, and never inside the declaration', async () => {
      await run({ ...opts(), skillVersion: '0.3.0' }, { readInput: async () => stop({ session_id: 's-a' }) });
      await run(opts(), { readInput: async () => stop({ session_id: 's-b' }) });

      expect(log(0).metadata.skill_version).toBe('0.3.0');
      expect(log(1).metadata.skill_version).toBeUndefined();
      expect(JSON.stringify(log(0).declared)).not.toContain('0.3.0'); // a new version must not mean a new workload
    });

    it.each([['a trailing space', 'qa-login '], ['a double slash', 'qa//login'], ['a control character', 'qa\tlogin'], ['only whitespace', '   ']])(
      'still lands the turn, undeclared and logged, when the SDK rejects the declaration (%s)',
      async (_label, skill) => {
        const code = await run({ ...opts(), skill }, { readInput: async () => stop() });

        expect(code).toBe(0);
        expect(server.received).toHaveLength(1); // the turn was not lost
        expect(log(0).declared).toBeUndefined(); // it lands unmatched
        expect(await listTurnFiles()).toHaveLength(0); // and was not left to be retried and dropped
        const hookLog = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
        expect(hookLog).toContain('workload declaration was rejected');
      }
    );

    it('writes the server\'s warnings to hook.log (for example the public-key cap on declared workloads), and the turn still lands', async () => {
      await server.close();
      server = await startFakeCoolhand(200, { id: 7, warnings: ['workload cap reached for this key; declaration ignored', { message: 'second warning' }] });

      const code = await run(opts(), { readInput: async () => stop() });

      expect(code).toBe(0);
      expect(server.received).toHaveLength(1);
      const hookLog = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
      expect(hookLog).toContain('workload cap reached for this key; declaration ignored');
      expect(hookLog).toContain('second warning');
      expect(await listTurnFiles()).toHaveLength(0);
    });

    it('writes nothing to hook.log when the server has no warnings', async () => {
      await run(opts(), { readInput: async () => stop() });
      await expect(fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8')).rejects.toThrow();
    });

    it('declares nothing without --skill, or with --no-declare', async () => {
      await run({ agent: 'claude', apiKey: 'pk_test_123', baseUrl: server.url }, { readInput: async () => stop({ session_id: 's-a' }) });
      await run({ ...opts(), declare: false }, { readInput: async () => stop({ session_id: 's-b' }) });

      expect(log(0).declared).toBeUndefined();
      expect(log(1).declared).toBeUndefined();
    });

    it('declares the workload again on a replay, exactly as the original send', async () => {
      await server.close();
      server = await startFakeCoolhand(500);
      await run({ ...opts(), skillVersion: '0.3.0' }, { readInput: async () => stop() });
      await server.close();
      server = await startFakeCoolhand(200);
      for (const file of await listTurnFiles()) {
        const text = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, text.replace(/"baseUrl": ".*"/, `"baseUrl": "${server.url}"`));
      }

      await replaySpooledTurns();

      expect(log(0).declared).toEqual({ reporter: 'coolhand-cli', workload: { key: 'claude-skill:qa-login', name: 'qa-login' } });
      expect(log(0).metadata).toMatchObject({ replayed: true, skill_version: '0.3.0' });
    });

    it("sends the skill's text as request_body.system, without the local path, and keeps sending it on later turns", async () => {
      const t1 = await write('skill-1', [{ u: '/qa-login', a: 'starting', skill: 'qa-login' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t1, last_assistant_message: 'starting' }) });
      // By the second turn the invocation is no longer in the transcript the hook can see.
      const t2 = await write('skill-2', [{ u: '/qa-login', a: 'starting' }, { u: 'next', a: 'done' }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t2, last_assistant_message: 'done' }) });

      for (const i of [0, 1]) {
        expect(log(i).raw_request.request_body.system).toBe(SKILL_BODY);
      }
      expect(JSON.stringify(server.received)).not.toContain('/Users/me');
      expect((await loadTurnState('claude', 'sess-1')).skillText).toBe(SKILL_BODY);
    });

    it("does not send some other skill's text, or any text when --skill is missing", async () => {
      const t = await write('other', [{ u: '/other', a: 'hi', skill: 'other-skill' }]);
      await run(opts(), { readInput: async () => stop({ session_id: 's-a', transcript_path: t, last_assistant_message: 'hi' }) });
      await run({ agent: 'claude', apiKey: 'pk_test_123', baseUrl: server.url }, { readInput: async () => stop({ session_id: 's-b', transcript_path: t, last_assistant_message: 'hi' }) });

      expect(log(0).raw_request.request_body.system).toBeUndefined();
      expect(log(1).raw_request.request_body.system).toBeUndefined();
    });

    it("sends the session's token usage so far in response_body.usage: cumulative, not per turn", async () => {
      const t1 = await write('use-1', [{ u: '/qa-login', a: 'one', usage: 1 }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t1, last_assistant_message: 'one' }) });
      const t2 = await write('use-2', [{ u: '/qa-login', a: 'one', usage: 1 }, { u: 'two', a: 'two', usage: 2 }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t2, last_assistant_message: 'two' }) });

      expect(log(0).raw_request.response_body.usage).toEqual(tokens(1));
      expect(log(1).raw_request.response_body.usage).toEqual(tokens(3)); // turn 1 + turn 2, not just turn 2
    });

    it('reports what subagents spent under metadata.subagent_usage, per model, and keeps it out of response_body.usage', async () => {
      const t = await write('agents', [{ u: '/qa-login', a: 'reviewed', usage: 1, agents: [{ id: 'a1', model: 'sonnet-x' }, { id: 'a2', model: 'opus-y' }] }]);
      await run(opts(), { readInput: async () => stop({ transcript_path: t, last_assistant_message: 'reviewed' }) });

      expect(log(0).metadata.subagent_usage).toEqual({
        calls: 2,
        total: tokens(2),
        by_model: { 'sonnet-x': tokens(1), 'opus-y': tokens(1) },
      });
      expect(log(0).raw_request.response_body.usage).toEqual(tokens(1)); // the main thread only
    });
  });

  it('an empty --api-key falls back to COOLHAND_API_KEY', async () => {
    process.env.COOLHAND_API_KEY = 'pk_from_env';
    await run({ agent: 'claude', apiKey: '', baseUrl: server.url }, { readInput: async () => stop() });
    expect(server.received[0].apiKey).toBe('pk_from_env');
  });

  it('gives up on a server that never answers and spools the turn instead of hanging the agent', async () => {
    const hang = http.createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    try {
      const started = Date.now();
      const outcome = await sendTurn(
        { url: 'u', request_body: { messages: [] }, response_body: { id: 'i', content: [] } },
        { apiKey: 'pk_test_123', baseUrl: url, collector: 'test', metadata: {}, timeoutMs: 150 }
      );
      expect(outcome).toBe('spooled');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await listTurnFiles()).toHaveLength(1);
      // Running out the clock leaves it unknown whether the server stored the turn.
      expect((await readPendingRecord((await listTurnFiles())[0])).ambiguous).toBe(true);
    } finally {
      hang.closeAllConnections();
      await new Promise<void>((resolve) => hang.close(() => resolve()));
    }
  });

  it('keeps credentials embedded in a bad --base-url out of hook.log', async () => {
    await run({ ...opts(), baseUrl: 'http://user:s3cretpass@example.com' }, { readInput: async () => stop() });

    const log = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
    expect(log).toContain('Invalid base url');
    expect(log).not.toContain('s3cretpass');
  });

  it('keeps a password containing @ in a bad --base-url out of hook.log', async () => {
    await run({ ...opts(), baseUrl: 'http://user:p@ssw0rdtail@example.com' }, { readInput: async () => stop() });

    const log = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
    expect(log).toContain('Invalid base url');
    expect(log).not.toContain('ssw0rdtail');
  });

  it('never throws and logs to hook.log when the base url is unusable', async () => {
    const code = await run({ ...opts(), baseUrl: 'http://example.com' }, { readInput: async () => stop() });

    expect(code).toBe(0);
    const log = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
    expect(log).toContain('capture-turn (claude) failed');
  });
  // Built from Cursor's docs with synthetic transcripts; not yet confirmed against a real Cursor run.
  describe('--agent cursor', () => {
    const cursorOpts = () => ({ ...opts(), agent: 'cursor' as const, skill: 'qa-cursor' });
    const ts = (i: number) => `2026-10-28T10:00:${String(i).padStart(2, '0')}.000Z`;
    const writeTranscript = async (name: string, exchanges: Array<{ u: string; a: string }>) => {
      const file = path.join(home.dir, `${name}.jsonl`);
      const lines = exchanges.flatMap((e, i) => [
        { role: 'user', timestamp: ts(i), message: { content: [{ type: 'text', text: `<user_query>\n${e.u}\n</user_query>` }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: e.a }] } },
      ]);
      await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
      return file;
    };
    const native = (event: string, extra: Record<string, unknown> = {}) => ({
      hook_event_name: event,
      conversation_id: 'conv-1',
      workspace_roots: ['/tmp/proj'],
      ...extra,
    });
    const sent = (i: number) => server.received[i].body.llm_request_log;

    it('two turns give a cumulative second payload with nothing from before the skill, redacted, filed under the cursor workload', async () => {
      const t1 = await writeTranscript('c1', [{ u: 'my private question', a: 'a private answer' }, { u: '/qa-cursor', a: 'starting' }]);
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: t1, text: 'starting' }) });
      const t2 = await writeTranscript('c2', [
        { u: 'my private question', a: 'a private answer' },
        { u: '/qa-cursor', a: 'starting' },
        { u: `check token=${SECRET}`, a: 'checked' },
      ]);
      await run(cursorOpts(), { readInput: async () => native('stop', { generation_id: 'g2', transcript_path: t2, status: 'completed' }) });

      expect(server.received).toHaveLength(2);
      expect(JSON.stringify(server.received)).not.toContain('private');
      expect(JSON.stringify(server.received)).not.toContain(SECRET);
      expect(sent(0).raw_request.url).toBe('coolhand-hook://cursor/session/conv-1/turn/1');
      const second = sent(1).raw_request;
      expect(second.url).toBe('coolhand-hook://cursor/session/conv-1/turn/2');
      expect(second.request_body.messages.map((m: { content: string }) => m.content)).toEqual(['/qa-cursor', 'starting', expect.stringContaining('check token=')]);
      expect(second.response_body.content).toEqual([{ type: 'text', text: 'checked' }]);
      expect(sent(1).metadata).toMatchObject({ agent: 'cursor', skill: 'qa-cursor', turn_index: 2 });
      expect(JSON.stringify(server.received[1].body)).toContain('cursor-skill:qa-cursor');
    });

    it('sends a turn once even though afterAgentResponse and stop both report it', async () => {
      const t = await writeTranscript('c3', [{ u: 'hello', a: 'hi there' }]);
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: t, text: 'hi there' }) });
      // The second event reports the same reply while the transcript has not caught up with the prompt.
      await run(cursorOpts(), { readInput: async () => native('stop', { generation_id: 'g1', transcript_path: t, status: 'completed' }) });
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: null, text: 'hi there' }) });

      expect(server.received).toHaveLength(1);
    });

    it('pairs a stashed beforeSubmitPrompt prompt with the reply when there is no transcript', async () => {
      await run(cursorOpts(), { readInput: async () => native('beforeSubmitPrompt', { prompt: 'what is 2+2?', transcript_path: null }) });
      expect(server.received).toHaveLength(0);
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: null, text: 'four' }) });

      expect(sent(0).raw_request.request_body.messages).toEqual([{ role: 'user', content: 'what is 2+2?' }]);
      expect((await loadTurnState('cursor', 'conv-1')).pendingPrompt).toBeUndefined(); // consumed
    });

    it('sends nothing for a --skill pattern, since a Cursor payload never says which skill ran, and says why in hook.log', async () => {
      const t = await writeTranscript('c6', [{ u: 'hello', a: 'hi there' }]);
      await run({ ...cursorOpts(), skill: 'qa-*' }, { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: t, text: 'hi there' }) });

      expect(server.received).toHaveLength(0);
      expect(await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8')).toContain('patterns are not supported');
    });

    it('counts the same reply with different whitespace (event text vs transcript) as one turn', async () => {
      const t = await writeTranscript('c7', [{ u: 'hello', a: 'hi\nthere' }]);
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: t, text: 'hi  there' }) });
      await run(cursorOpts(), { readInput: async () => native('stop', { generation_id: 'g1', transcript_path: t, status: 'completed' }) });

      expect(server.received).toHaveLength(1);
    });

    it('spools a turn the server refuses, and a later turn replays it', async () => {
      await server.close();
      server = await startFakeCoolhand(500);
      const t = await writeTranscript('c4', [{ u: 'hello', a: 'hi there' }]);
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { generation_id: 'g1', transcript_path: t, text: 'hi there' }) });
      expect(await listTurnFiles()).toHaveLength(1);

      // A different conversation, so the spooled turn is replayed rather than superseded by a newer turn of its own.
      await server.close();
      server = await startFakeCoolhand(200);
      const spooledFile = (await listTurnFiles())[0];
      await fs.writeFile(spooledFile, (await fs.readFile(spooledFile, 'utf8')).replace(/"baseUrl": ".*"/, `"baseUrl": "${server.url}"`));
      const t2 = await writeTranscript('c5', [{ u: 'other', a: 'reply' }]);
      await run(cursorOpts(), { readInput: async () => native('afterAgentResponse', { conversation_id: 'conv-2', generation_id: 'g9', transcript_path: t2, text: 'reply' }) });

      expect(await listTurnFiles()).toHaveLength(0);
      expect(server.received.map((r) => r.body.llm_request_log.raw_request.url).sort()).toEqual([
        'coolhand-hook://cursor/session/conv-1/turn/1',
        'coolhand-hook://cursor/session/conv-2/turn/1',
      ]);
    });
  });
});

describe('capture-turn --agent copilot', () => {
  let home: TmpHome;
  let server: FakeCoolhand;
  let transcriptPath: string;
  const savedEnv = { ...process.env };

  const stop = (sessionId = 'cop-1') => ({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath, cwd: '/tmp/proj', stop_reason: 'end_turn' });
  const opts = () => ({ agent: 'copilot' as const, skill: 'qa-login', apiKey: 'pk_test_123', baseUrl: server.url });
  const write = (...lines: string[]) => fs.writeFile(transcriptPath, lines.join('\n') + '\n');
  const messagesOf = (i: number) => server.received[i].body.llm_request_log.raw_request.request_body.messages;

  beforeEach(async () => {
    home = await createTmpHome();
    server = await startFakeCoolhand();
    transcriptPath = path.join(home.dir, 'events.jsonl');
    process.env.COOLHAND_CAPTURE_USER = 'tester@example.com';
    delete process.env.COOLHAND_API_KEY;
    delete process.env.COOLHAND_CAPTURE_DISABLED;
  });

  afterEach(async () => {
    await server.close();
    await home.cleanup();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  // A chat that talked before the skill was invoked, then ran it for two turns.
  const BEFORE = [events.user('private question before the skill'), events.assistant('private answer')];
  const TURN_1 = [
    events.skill('qa-login'),
    events.user('/qa-login'),
    events.assistant('', [{ toolCallId: 'c1', name: 'run_in_terminal', arguments: { command: 'ls' } }]),
    events.result('c1', 'file.txt'),
    events.assistant(`Checklist started. token=${SECRET}`),
  ];
  const TURN_2 = [events.user('and the second step?'), events.assistant('Second step done.')];

  it('sends one cumulative log per turn: nothing from before the skill, secrets redacted, the skill text as system', async () => {
    await write(...BEFORE, ...TURN_1);
    await run(opts(), { readInput: async () => stop() });
    await write(...BEFORE, ...TURN_1, ...TURN_2);
    await run(opts(), { readInput: async () => stop() });

    expect(server.received).toHaveLength(2);
    expect(server.received[0].apiKey).toBe('pk_test_123');
    expect(messagesOf(0)).toEqual([
      { role: 'user', content: '/qa-login' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'run_in_terminal', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file.txt' }] },
    ]);
    // The second log is the whole conversation since the skill ran.
    expect(messagesOf(1).map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messagesOf(1)[0]).toEqual({ role: 'user', content: '/qa-login' });
    expect(messagesOf(1)[3]).toEqual({ role: 'assistant', content: expect.stringContaining('Checklist started.') });
    expect(messagesOf(1)[4]).toEqual({ role: 'user', content: 'and the second step?' });

    const raw = JSON.stringify(server.received);
    expect(raw).not.toContain('private question before the skill');
    expect(raw).not.toContain('private answer');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('coolhand-hook://copilot/session/cop-1/turn/1');
    expect(raw).toContain('coolhand-hook://copilot/session/cop-1/turn/2');
    expect(raw).toContain('copilot-skill:qa-login');
    expect(raw).toContain('SKILL BODY');
    expect(server.received[1].body.llm_request_log.raw_request.response_body.content).toEqual([{ type: 'text', text: 'Second step done.' }]);
  });

  it('sends nothing for a chat that never invoked the skill, or that invoked another one', async () => {
    await write(...BEFORE);
    await run(opts(), { readInput: async () => stop('unrelated') });
    await write(events.skill('some-other-skill'), events.user('/other'), events.assistant('other done'));
    await run(opts(), { readInput: async () => stop('other') });
    await run({ ...opts(), skill: undefined }, { readInput: async () => stop('no-skill-flag') });

    expect(server.received).toHaveLength(0);
    // The one case that is a misconfiguration, not a quiet chat, says so in the log.
    expect(await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8')).toContain('--skill is required');
    expect(await listTurnFiles()).toHaveLength(0);
  });

  it('with --skill "*" captures whichever skill the chat invoked, as that skill\'s workload, and stays on it', async () => {
    const any = () => ({ ...opts(), skill: '*' });
    const OTHER = [events.skill('other-skill'), events.user('/other-skill'), events.assistant('other done')];
    await write(...BEFORE, ...TURN_1);
    await run(any(), { readInput: async () => stop() });
    // The chat then runs a second skill: the session stays on the first.
    await write(...BEFORE, ...TURN_1, ...OTHER);
    await run(any(), { readInput: async () => stop() });
    // A chat that invoked no skill is still silent.
    await write(...BEFORE);
    await run(any(), { readInput: async () => stop('unrelated') });

    expect(server.received).toHaveLength(2);
    const raw = JSON.stringify(server.received);
    expect(raw).toContain('copilot-skill:qa-login');
    expect(raw).not.toContain('copilot-skill:other-skill');
    expect(raw).not.toContain('copilot-skill:*');
    expect(raw).toContain('SKILL BODY');
    for (const r of server.received) {
      expect(r.body.llm_request_log.metadata.skill).toBe('qa-login');
    }
    expect(await listTurnFiles()).toHaveLength(0);
  });

  it('with --skill "qa-*" captures only skills whose name starts with qa-', async () => {
    await write(events.skill('other-skill'), events.user('/other-skill'), events.assistant('other done'));
    await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop('other') });
    expect(server.received).toHaveLength(0);

    await write(...TURN_1);
    await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop('mine') });
    expect(server.received).toHaveLength(1);
    expect(JSON.stringify(server.received)).toContain('copilot-skill:qa-login');
  });

  it('treats a * that is not at the end as a literal name, and --no-declare declares no workload for a pattern', async () => {
    await write(...TURN_1);
    await run({ ...opts(), skill: '*-login' }, { readInput: async () => stop('mid') });
    expect(server.received).toHaveLength(0);

    await run({ ...opts(), skill: 'qa-*', declare: false }, { readInput: async () => stop('nodeclare') });
    expect(server.received).toHaveLength(1);
    expect(server.received[0].body.llm_request_log.metadata.skill).toBe('qa-login');
    expect(JSON.stringify(server.received)).not.toContain('copilot-skill:');
  });

  it('ignores a pin saved in a Copilot session state, and does not write one: the transcript there is cumulative', async () => {
    await saveTurnState('copilot', 'cop-pin', { turnIndex: 0, skill: 'zzz-other' });
    await write(...TURN_1);
    await run({ ...opts(), skill: 'qa-*' }, { readInput: async () => stop('cop-pin') });
    expect(server.received).toHaveLength(1);
    expect(server.received[0].body.llm_request_log.metadata.skill).toBe('qa-login');
    expect((await loadTurnState('copilot', 'cop-pin')).skill).toBeUndefined();
  });

  it('does not resend a double-fired Stop', async () => {
    await write(...TURN_1);
    await run(opts(), { readInput: async () => stop() });
    await run(opts(), { readInput: async () => stop() });
    expect(server.received).toHaveLength(1);
  });

  it('spools the turn when Coolhand refuses it and exits 0', async () => {
    await server.close();
    server = await startFakeCoolhand(500);
    await write(...TURN_1);

    expect(await run(opts(), { readInput: async () => stop() })).toBe(0);
    expect(await listTurnFiles()).toHaveLength(1);
    expect((await readPendingRecord((await listTurnFiles())[0])).kind).toBe('turn');
  });

  it("replays another session's spooled turn on a later successful send", async () => {
    await server.close();
    server = await startFakeCoolhand(500);
    await write(...TURN_1);
    await run(opts(), { readInput: async () => stop('older-session') });
    const spooledFile = (await listTurnFiles())[0];

    await server.close();
    server = await startFakeCoolhand(200);
    const spooled = await fs.readFile(spooledFile, 'utf8');
    await fs.writeFile(spooledFile, spooled.replace(/"baseUrl": ".*"/, `"baseUrl": "${server.url}"`));
    await run(opts(), { readInput: async () => stop('newer-session') });

    // The new turn, then the spooled one from the other session.
    expect(server.received).toHaveLength(2);
    expect(await listTurnFiles()).toHaveLength(0);
    expect(JSON.stringify(server.received)).toContain('coolhand-hook://copilot/session/older-session/turn/1');
  });
});

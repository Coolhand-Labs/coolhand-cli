import http from 'http';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import { run } from '../../src/commands/capture-turn.js';
import { replaySpooledTurns, sendTurn } from '../../src/hooks/send-turn.js';
import { countPending, listTurnFiles, readPendingRecord, savePendingRecord } from '../../src/pending-store.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

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

async function startFakeCoolhand(status = 200): Promise<FakeCoolhand> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === INGEST_PATH) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ apiKey: req.headers['x-api-key'] as string | undefined, body: JSON.parse(body) });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status < 300 ? { id: 1 } : { error: 'boom' }));
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

  it('sends the user and assistant text of the turn with the public key, and nothing else', async () => {
    const code = await run(opts(), { readInput: async () => stop() });

    expect(code).toBe(0);
    expect(server.received).toHaveLength(1);
    const { apiKey, body } = server.received[0];
    expect(apiKey).toBe('pk_test_123');
    const raw = JSON.stringify(body);
    expect(raw).toContain('Run the login QA checklist');
    expect(raw).toContain('Checklist done.');
    expect(raw).not.toContain('INJECTED SKILL BODY');
    expect(raw).not.toContain('tool_use');
    expect(raw).not.toContain('file.txt');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('coolhand-hook://claude/session/sess-1/turn/1');
    expect(raw).toContain('sess-1:1');
    expect(raw).toContain('tester@example.com');
    expect(raw).toContain('qa-login');
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

  it('exits 0 and spools the turn when the server refuses it, then replays it after the next success', async () => {
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
    expect(await listTurnFiles()).toHaveLength(0);
    expect(server.received).toHaveLength(2); // the new turn plus the replayed one
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

  it('never throws and logs to hook.log when the base url is unusable', async () => {
    const code = await run({ ...opts(), baseUrl: 'http://example.com' }, { readInput: async () => stop() });

    expect(code).toBe(0);
    const log = await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8');
    expect(log).toContain('capture-turn (claude) failed');
  });
});

import { spawn } from 'child_process';
import http from 'http';
import { AddressInfo } from 'net';
import { existsSync, promises as fs, readdirSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * End to end through the BUILT binary, the way Claude Code runs the hook: one process per turn, the
 * hook payload on stdin, state carried between processes only by files on disk, a local server
 * standing in for Coolhand. Needs `npm run build` first (the verify gate does that); skipped otherwise.
 */
const BIN = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const maybe = existsSync(BIN) ? describe : describe.skip;

/** Source files edited after dist/bin.js was built: the binary under test would not be the code in the repo. */
function sourceNewerThanBuild(dir = path.join(__dirname, '..', '..', 'src')): string[] {
  const built = statSync(BIN).mtimeMs;
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceNewerThanBuild(full);
    }
    return entry.name.endsWith('.ts') && statSync(full).mtimeMs > built ? [path.relative(path.join(__dirname, '..', '..'), full)] : [];
  });
}

const SKILL_BODY = '# Loop Review\nReview, fix, re-review.';
const tokens = (n: number) => ({ input_tokens: n, output_tokens: n * 2, cache_read_input_tokens: n * 10, cache_creation_input_tokens: n * 3 });

interface Received {
  apiKey: string | undefined;
  log: Record<string, any>;
}

async function startServer(responseBody: object = { id: 1 }): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ apiKey: req.headers['x-api-key'] as string | undefined, log: JSON.parse(body).llm_request_log });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function runBinary(args: string[], stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

maybe('capture-turn, as the built binary run once per turn', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  const ts = (i: number) => `2026-10-28T10:00:${String(i).padStart(2, '0')}.000Z`;

  const env = (extra: Record<string, string> = {}): Record<string, string> => {
    const base = { ...process.env } as Record<string, string>;
    delete base.COOLHAND_API_KEY;
    delete base.COOLHAND_CAPTURE_DISABLED;
    return { ...base, COOLHAND_CONFIG_DIR: path.join(dir, 'config'), COOLHAND_CAPTURE_USER: 'binary@test.example', ...extra };
  };
  const args = (extra: string[] = []) => ['capture-turn', '--agent', 'claude', '--skill', 'loop-review', '--skill-version', '0.3.0', '--api-key', 'pk_binary', '--base-url', server.url, ...extra];

  /** A real-shaped transcript: slash command, injected skill body, tool loop with a subagent, usage on messages. */
  async function transcript(turns: number): Promise<string> {
    const lines: unknown[] = [
      { type: 'user', timestamp: ts(0), message: { role: 'user', content: 'a private chat before the skill' } },
      { type: 'assistant', requestId: 'p', timestamp: ts(0), message: { id: 'p', role: 'assistant', content: [{ type: 'text', text: 'a private reply' }] } },
      { type: 'user', timestamp: ts(1), message: { role: 'user', content: '<command-message>loop-review</command-message>\n<command-name>/loop-review</command-name>\n<command-args>high</command-args>' } },
      { type: 'user', isMeta: true, timestamp: ts(1), message: { role: 'user', content: `Base directory for this skill: /Users/someone/.claude/skills/loop-review\n\n${SKILL_BODY}` } },
      { type: 'assistant', requestId: 'r0', timestamp: ts(1), message: { id: 'r0', role: 'assistant', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { prompt: 'review this' } }] } },
      { type: 'user', timestamp: ts(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'reviewed' }] }, toolUseResult: { status: 'completed', agentId: 'ag1', resolvedModel: 'sonnet-x', usage: tokens(1) } },
      { type: 'assistant', requestId: 'r1', timestamp: ts(1), message: { id: 'r1', role: 'assistant', content: [{ type: 'thinking', thinking: 'plan round one', signature: 'opaque-signature' }, { type: 'text', text: 'round one done' }], usage: tokens(2) } },
    ];
    if (turns >= 2) {
      lines.push(
        { type: 'user', timestamp: ts(2), message: { role: 'user', content: 'now the second pass <system_instruction>host-injected /Users/someone/workspace</system_instruction>' } },
        { type: 'assistant', requestId: 'r2', timestamp: ts(2), message: { id: 'r2', role: 'assistant', content: [{ type: 'thinking', thinking: 'plan round two', signature: 'opaque-signature' }, { type: 'text', text: 'round two done' }], usage: tokens(3) } }
      );
    }
    const file = path.join(dir, `transcript-${turns}.jsonl`);
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
  }
  const payload = (file: string, reply: string) => JSON.stringify({ hook_event_name: 'Stop', session_id: 'bin-session', transcript_path: file, cwd: '/tmp/proj', last_assistant_message: reply });

  it('is testing a build that matches the source (run `npm run build` if this fails)', () => {
    expect(sourceNewerThanBuild()).toEqual([]);
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-binary-'));
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('sends a conversation-so-far log per turn, declared to the skill\'s workload, with its text, version and token usage', async () => {
    const first = await runBinary(args(), payload(await transcript(1), 'round one done'), env());
    const second = await runBinary(args(), payload(await transcript(2), 'round two done'), env());

    // A hook is invisible to the agent: exit 0, nothing printed.
    for (const r of [first, second]) {
      expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(server.received).toHaveLength(2);
    expect(server.received.map((r) => r.apiKey)).toEqual(['pk_binary', 'pk_binary']);
    const [t1, t2] = server.received.map((r) => r.log);

    // Declaration: the workload only, the same key on both turns, no template, no version in it.
    for (const t of [t1, t2]) {
      expect(t.declared).toEqual({ reporter: 'coolhand-cli', workload: { key: 'claude-skill:loop-review', name: 'loop-review' } });
      expect(t.metadata).toMatchObject({ skill: 'loop-review', skill_version: '0.3.0', session_id: 'bin-session', tester: 'binary@test.example' });
    }

    // Turn 1: the slash command as typed, then the turn's own tool loop; the final reply (thinking + text) is the response.
    // The skill's text goes in `system` without the local path.
    expect(t1.raw_request.url).toBe('coolhand-hook://claude/session/bin-session/turn/1');
    expect(t1.raw_request.request_body.messages).toEqual([
      { role: 'user', content: '/loop-review high' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { prompt: 'review this' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'reviewed' }] },
    ]);
    expect(t1.raw_request.response_body.content).toEqual([{ type: 'thinking', thinking: 'plan round one' }, { type: 'text', text: 'round one done' }]);
    expect(t1.raw_request.request_body.system).toBe(SKILL_BODY);
    expect(t1.raw_request.response_body.usage).toEqual(tokens(2));
    expect(t1.metadata.subagent_usage).toEqual({ calls: 1, total: tokens(1), by_model: { 'sonnet-x': tokens(1) } });

    // Turn 2: the conversation so far, host-injected text stripped, cumulative usage, the skill text still present.
    expect(t2.raw_request.url).toBe('coolhand-hook://claude/session/bin-session/turn/2');
    expect(t2.raw_request.request_body.messages).toEqual([
      { role: 'user', content: '/loop-review high' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { prompt: 'review this' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'reviewed' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan round one' }, { type: 'text', text: 'round one done' }] },
      { role: 'user', content: 'now the second pass' },
    ]);
    expect(t2.raw_request.request_body.system).toBe(SKILL_BODY);
    expect(t2.raw_request.response_body.content).toEqual([{ type: 'thinking', thinking: 'plan round two' }, { type: 'text', text: 'round two done' }]);
    expect(t2.raw_request.response_body.usage).toEqual(tokens(5)); // 2 + 3, not just this turn
    expect(t2.metadata.subagent_usage.calls).toBe(1);
    expect(t2.metadata.history_truncated).toBeUndefined();

    // Nothing from before the skill, nothing host-injected, no local paths, anywhere on the wire.
    expect(JSON.stringify(server.received)).not.toMatch(/private|Users\/someone|host-injected|system_instruction|opaque-signature/);
  });

  it('is silent and sends nothing without a key or with the kill switch on', async () => {
    const file = await transcript(1);
    const noKey = await runBinary(args().filter((a, i, all) => a !== '--api-key' && all[i - 1] !== '--api-key'), payload(file, 'round one done'), env());
    const off = await runBinary(args(), payload(file, 'round one done'), env({ COOLHAND_CAPTURE_DISABLED: '1' }));

    for (const r of [noKey, off]) {
      expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(server.received).toHaveLength(0);
  });

  it('exits 0 and prints nothing for a bad flag when run by an agent, and for garbage on stdin', async () => {
    const badFlag = await runBinary(['capture-turn', '--agent', 'nonsense'], '{}', env());
    const garbage = await runBinary(args(), 'this is not json', env());

    for (const r of [badFlag, garbage]) {
      expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(server.received).toHaveLength(0);
  });

  it('lands the turn undeclared, and says so in hook.log, when the skill name makes an invalid workload key', async () => {
    const result = await runBinary(args().map((a) => (a === 'loop-review' ? 'loop-review ' : a)), payload(await transcript(1), 'round one done'), env());

    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(server.received).toHaveLength(1);
    expect(server.received[0].log.declared).toBeUndefined();
    expect(await fs.readFile(path.join(dir, 'config', 'capture-turns', 'hook.log'), 'utf8')).toContain('declaration was rejected');
  });

  it('records the server\'s warnings in hook.log and still counts the turn as sent', async () => {
    await server.close();
    server = await startServer({ id: 9, warnings: ['declared-workload cap reached for this public key; declaration ignored'] });

    const result = await runBinary(args(), payload(await transcript(1), 'round one done'), env());

    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await fs.readFile(path.join(dir, 'config', 'capture-turns', 'hook.log'), 'utf8')).toContain('declaration ignored');
    await expect(fs.readdir(path.join(dir, 'config', 'pending'))).rejects.toThrow(); // nothing spooled: it landed
  });
});

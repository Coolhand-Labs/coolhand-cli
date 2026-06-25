import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { scanCoworkSessions } from '../../src/sessions/cowork-scanner.js';

/** A realistic Cowork audit.jsonl with extra Cowork-only event types that should be ignored. */
const COWORK_SAMPLE = [
  // system/init — no `message` field, must be ignored
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-abc',
    tools: [],
    model: 'claude-sonnet-4-6',
    _audit_timestamp: '2026-01-01T00:00:00.000Z',
    _audit_hmac: 'abc123',
  }),
  // rate_limit_event — no `message` field, must be ignored
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed' },
    uuid: 'rl-uuid',
    session_id: 'sess-abc',
    _audit_timestamp: '2026-01-01T00:00:00.000Z',
    _audit_hmac: 'def456',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Hello from Cowork' },
    session_id: 'sess-abc',
    _audit_timestamp: '2026-01-01T00:00:00.000Z',
    _audit_hmac: 'ghi789',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'msg_cowork_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Cowork response.' }],
      usage: { input_tokens: 15, output_tokens: 8, cache_read_input_tokens: 0 },
    },
    session_id: 'sess-abc',
    _audit_timestamp: '2026-01-01T00:00:00.000Z',
    _audit_hmac: 'jkl012',
  }),
].join('\n');

/** Helper: create the full Cowork directory structure for one session. */
async function writeCoworkSession(
  baseDir: string,
  workspaceId: string,
  coworkSessionId: string,
  localUuid: string,
  content: string
): Promise<string> {
  const sessionDir = path.join(baseDir, workspaceId, coworkSessionId, `local_${localUuid}`);
  await fs.mkdir(sessionDir, { recursive: true });
  const auditPath = path.join(sessionDir, 'audit.jsonl');
  await fs.writeFile(auditPath, content);
  return auditPath;
}

describe('scanCoworkSessions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `cws-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('returns empty when the sessions dir does not exist', async () => {
    const res = await scanCoworkSessions({ sessionsDir: path.join(dir, 'missing') });
    expect(res).toEqual({ envelopes: [], sessionCount: 0 });
  });

  test('returns empty when the sessions dir is unreadable (does not abort the run)', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o000);
    try {
      const res = await scanCoworkSessions({ sessionsDir: dir });
      expect(res).toEqual({ envelopes: [], sessionCount: 0 });
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });

  test('produces one envelope per local session', async () => {
    await writeCoworkSession(dir, 'ws-1', 'cs-1', 'local-uuid-a', COWORK_SAMPLE);
    await writeCoworkSession(dir, 'ws-1', 'cs-1', 'local-uuid-b', COWORK_SAMPLE);
    const res = await scanCoworkSessions({ sessionsDir: dir });
    expect(res.sessionCount).toBe(2);
    expect(res.envelopes).toHaveLength(2);
  });

  test('uses cowork:// url scheme with the local session uuid', async () => {
    await writeCoworkSession(dir, 'ws-1', 'cs-1', 'abc-123', COWORK_SAMPLE);
    const res = await scanCoworkSessions({ sessionsDir: dir });
    expect(res.envelopes[0].url).toBe('cowork://session/abc-123');
  });

  test('ignores Cowork-only event types (system/init, rate_limit_event)', async () => {
    await writeCoworkSession(dir, 'ws-1', 'cs-1', 'uuid-1', COWORK_SAMPLE);
    const res = await scanCoworkSessions({ sessionsDir: dir });
    // Only the real user and assistant messages make it into the envelope
    expect(res.envelopes[0].request_body.messages).toEqual([
      { role: 'user', content: 'Hello from Cowork' },
      { role: 'assistant', content: 'Cowork response.' },
    ]);
  });

  test('skips a session file that has no assistant turns', async () => {
    const onlyUser = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      session_id: 'x',
    });
    await writeCoworkSession(dir, 'ws-1', 'cs-1', 'empty-uuid', onlyUser);
    const res = await scanCoworkSessions({ sessionsDir: dir });
    expect(res.sessionCount).toBe(1);
    expect(res.envelopes).toHaveLength(0);
  });

  test('skips files not matching the local_*/audit.jsonl pattern', async () => {
    // A plain .jsonl file at the wrong path should not be picked up
    const wrongPath = path.join(dir, 'ws-1', 'cs-1');
    await fs.mkdir(wrongPath, { recursive: true });
    await fs.writeFile(path.join(wrongPath, 'audit.jsonl'), COWORK_SAMPLE);
    const res = await scanCoworkSessions({ sessionsDir: dir });
    expect(res.envelopes).toHaveLength(0);
  });

  test('sinceTime skips files older than the cutoff', async () => {
    const oldPath = await writeCoworkSession(dir, 'ws-1', 'cs-1', 'old-uuid', COWORK_SAMPLE);
    const newPath = await writeCoworkSession(dir, 'ws-1', 'cs-1', 'new-uuid', COWORK_SAMPLE);

    const cutoff = new Date('2026-06-10T00:00:00.000Z');
    await fs.utimes(oldPath, new Date('2026-06-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z'));
    await fs.utimes(newPath, new Date('2026-06-20T00:00:00.000Z'), new Date('2026-06-20T00:00:00.000Z'));

    const res = await scanCoworkSessions({ sessionsDir: dir, sinceTime: cutoff });
    expect(res.sessionCount).toBe(1);
    expect(res.envelopes[0].url).toBe('cowork://session/new-uuid');
  });

  test('sinceTime includes a file whose mtime equals the cutoff', async () => {
    const cutoff = new Date('2026-06-10T00:00:00.000Z');
    const auditPath = await writeCoworkSession(dir, 'ws-1', 'cs-1', 'edge-uuid', COWORK_SAMPLE);
    await fs.utimes(auditPath, cutoff, cutoff);

    const res = await scanCoworkSessions({ sessionsDir: dir, sinceTime: cutoff });
    expect(res.envelopes).toHaveLength(1);
  });
});

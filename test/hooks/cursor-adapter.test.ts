import { promises as fs } from 'fs';
import * as path from 'path';
import { cursorTurn } from '../../src/hooks/adapters/cursor.js';
import { parseCursorExchanges } from '../../src/sessions/cursor-scanner.js';
import { loadTurnState, saveTurnState } from '../../src/hooks/turn-state.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

/**
 * Synthetic, not recorded from a real Cursor run (see test/fixtures/cursor/README.md): these prove the
 * adapter does what the documented payloads and the assumed transcript shape ask of it.
 */
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'cursor', 'transcript.synthetic.jsonl');

describe('parseCursorExchanges', () => {
  it('pairs each prompt with its reply, keeps the tool loop, and unwraps <user_query>', async () => {
    const { exchanges } = parseCursorExchanges(await fs.readFile(FIXTURE, 'utf8'));

    expect(exchanges.map((e) => [e.userText, e.assistantText])).toEqual([
      ['what is 2+2?', 'four'],
      ['run ls and times three', 'twelve'],
    ]);
    expect(exchanges[1].timestamp).toBe('2026-10-28T10:00:01.000Z');
    expect(exchanges[1].messages?.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  it('skips lines it cannot read, including a partial first line', () => {
    const { exchanges } = parseCursorExchanges(`{"partial\nnot json\n${JSON.stringify({ role: 'user', message: { content: 'hi' } })}\n${JSON.stringify({ role: 'assistant', message: { content: 'hello' } })}`);
    expect(exchanges.map((e) => [e.userText, e.assistantText])).toEqual([['hi', 'hello']]);
  });
});

describe('cursorTurn', () => {
  let home: TmpHome;
  beforeEach(async () => {
    home = await createTmpHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  const native = (event: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: event,
    conversation_id: 'conv-1',
    generation_id: 'gen-2',
    workspace_roots: ['/tmp/proj'],
    transcript_path: FIXTURE,
    ...extra,
  });

  it('afterAgentResponse with a transcript that shows the turn: the whole conversation so far', async () => {
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'twelve' }));

    expect(turn).toMatchObject({
      sessionId: 'conv-1',
      userText: 'run ls and times three',
      assistantText: 'twelve',
      turnKey: 'gen-2',
      cwd: '/tmp/proj',
      exchangeTimestamp: '2026-10-28T10:00:01.000Z',
      earlier: [{ userText: 'what is 2+2?', assistantText: 'four' }],
      finalReply: [{ type: 'text', text: 'twelve' }],
    });
    expect(turn?.currentMessages?.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('prompt then reply: beforeSubmitPrompt sends nothing but stashes the prompt for the reply', async () => {
    const noTranscript = { transcript_path: null };
    expect(await cursorTurn(native('beforeSubmitPrompt', { prompt: 'what is 2+2?', ...noTranscript }))).toBeNull();
    expect((await loadTurnState('cursor', 'conv-1')).pendingPrompt).toBe('what is 2+2?');

    const turn = await cursorTurn(native('afterAgentResponse', { text: 'four', ...noTranscript }));
    expect(turn).toMatchObject({ userText: 'what is 2+2?', assistantText: 'four', exchangeTimestamp: undefined });
  });

  it('a reply with no stashed prompt and no transcript is still sent, without the user half', async () => {
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'four', transcript_path: null }));
    expect(turn).toMatchObject({ assistantText: 'four', userText: undefined });
  });

  it('the stop-only path takes the reply from the transcript, since stop carries none', async () => {
    const turn = await cursorTurn(native('stop', { status: 'completed', loop_count: 0 }));
    expect(turn).toMatchObject({ assistantText: 'twelve', userText: 'run ls and times three', exchangeTimestamp: '2026-10-28T10:00:01.000Z' });
  });

  it('a reply fired twice (afterAgentResponse then stop) is the same turn key', async () => {
    const first = await cursorTurn(native('afterAgentResponse', { text: 'twelve' }));
    const second = await cursorTurn(native('stop', { status: 'completed' }));
    expect([second?.turnKey, second?.assistantText]).toEqual([first?.turnKey, first?.assistantText]);
  });

  it('accepts a Claude-shaped Stop payload', async () => {
    const turn = await cursorTurn({ hook_event_name: 'Stop', session_id: 'sess-9', transcript_path: FIXTURE, cwd: '/tmp/x', last_assistant_message: 'twelve' });
    expect(turn).toMatchObject({ sessionId: 'sess-9', assistantText: 'twelve', cwd: '/tmp/x', userText: 'run ls and times three' });
  });

  it('a lagging transcript gives no timestamp and no tool loop, and keeps every exchange as history', async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'and plus one?' }));
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'thirteen' }));

    expect(turn?.exchangeTimestamp).toBeUndefined();
    expect(turn?.currentMessages).toBeUndefined();
    expect(turn?.userText).toBe('and plus one?');
    expect(turn?.earlier?.map((e) => e.userText)).toEqual(['what is 2+2?', 'run ls and times three']);
  });

  it('still captures the reply when the transcript is missing', async () => {
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'twelve', transcript_path: path.join(home.dir, 'nope.jsonl') }));
    expect(turn).toMatchObject({ assistantText: 'twelve', userText: undefined, earlier: [] });
  });

  it('a stop whose transcript has not moved past an already captured exchange sends nothing', async () => {
    await saveTurnState('cursor', 'conv-1', { turnIndex: 1, captured: ['2026-10-28T10:00:01.000Z'] });
    // The fixture's latest exchange is that one, so a new generation's stop would otherwise resend it.
    expect(await cursorTurn(native('stop', { generation_id: 'gen-3', status: 'completed' }))).toBeNull();
  });

  it('a stop whose transcript still shows the previous prompt, while a newer one is stashed, sends nothing', async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'and plus one?', generation_id: 'gen-3' }));
    expect(await cursorTurn(native('stop', { generation_id: 'gen-3', status: 'completed' }))).toBeNull();
  });

  it('replaces the stash on every prompt, so a blank one leaves nothing to attach to a later reply', async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'first', generation_id: 'g1', transcript_path: null }));
    await cursorTurn(native('beforeSubmitPrompt', { prompt: '', generation_id: 'g2', transcript_path: null }));
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'reply', generation_id: 'g2', transcript_path: null }));
    expect(turn?.userText).toBeUndefined();
  });

  it('drops the stash of an aborted turn', async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'aborted one', generation_id: 'g1', transcript_path: null }));
    expect(await cursorTurn(native('stop', { status: 'aborted', generation_id: 'g1', transcript_path: null }))).toBeNull();
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'reply', generation_id: 'g2', transcript_path: null }));
    expect(turn?.userText).toBeUndefined();
  });

  it("a reply from another generation does not take a prompt stashed for a different one", async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'for g1', generation_id: 'g1', transcript_path: null }));
    const turn = await cursorTurn(native('afterAgentResponse', { text: 'reply', generation_id: 'g2', transcript_path: null }));
    expect(turn?.userText).toBeUndefined();
  });

  it('redacts a secret in the prompt before stashing it on disk', async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'use token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', generation_id: 'g1', transcript_path: null }));
    expect((await loadTurnState('cursor', 'conv-1')).pendingPrompt).not.toContain('sk-ant-api03');
  });

  it('sends a stop-only turn whose prompt contained a secret, which the stash redacted but the transcript did not', async () => {
    const file = path.join(home.dir, 'secret.jsonl');
    const lines = [
      { role: 'user', timestamp: '2026-10-28T10:00:05.000Z', message: { content: [{ type: 'text', text: '<user_query>\nuse token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
    ];
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'use token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', generation_id: 'g1', transcript_path: null }));

    const turn = await cursorTurn(native('stop', { generation_id: 'g1', status: 'completed', transcript_path: file }));
    expect(turn).toMatchObject({ assistantText: 'done' });
  });

  it('cannot tell a lagging transcript from a new one when its lines carry no timestamps (a known limit)', async () => {
    const file = path.join(home.dir, 'nostamps.jsonl');
    await fs.writeFile(file, [{ role: 'user', message: { content: 'hello' } }, { role: 'assistant', message: { content: 'hi' } }].map((l) => JSON.stringify(l)).join('\n'));
    await saveTurnState('cursor', 'conv-1', { turnIndex: 1, captured: [] });
    expect(await cursorTurn(native('stop', { generation_id: 'g2', status: 'completed', transcript_path: file }))).toMatchObject({ assistantText: 'hi' });
  });

  it('does not treat a short prompt that merely starts another as the same prompt', async () => {
    const file = path.join(home.dir, 'short.jsonl');
    await fs.writeFile(file, [{ role: 'user', message: { content: 'continue' } }, { role: 'assistant', message: { content: 'old reply' } }].map((l) => JSON.stringify(l)).join('\n'));
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'continue with the second step', generation_id: 'g1', transcript_path: null }));
    expect(await cursorTurn(native('stop', { generation_id: 'g1', status: 'completed', transcript_path: file }))).toBeNull();
  });

  it('a payload that carries the reply is not held back by an already captured transcript exchange', async () => {
    await saveTurnState('cursor', 'conv-1', { turnIndex: 1, captured: ['2026-10-28T10:00:01.000Z'] });
    expect(await cursorTurn(native('afterAgentResponse', { text: 'twelve', generation_id: 'g3' }))).toMatchObject({ assistantText: 'twelve' });
    expect(await cursorTurn({ hook_event_name: 'Stop', session_id: 'conv-1', transcript_path: FIXTURE, last_assistant_message: 'twelve' })).toMatchObject({ assistantText: 'twelve' });
  });

  it('a stash for another generation does not hold back a stop-only turn', async () => {
    await cursorTurn(native('beforeSubmitPrompt', { prompt: 'something else entirely', generation_id: 'g-other', transcript_path: null }));
    expect(await cursorTurn(native('stop', { generation_id: 'gen-2', status: 'completed' }))).toMatchObject({ assistantText: 'twelve' });
  });

  it('sends nothing for other events, aborted or errored runs, or a payload with no session', async () => {
    expect(await cursorTurn(native('afterFileEdit', { text: 'x' }))).toBeNull();
    expect(await cursorTurn(native('stop', { status: 'aborted' }))).toBeNull();
    expect(await cursorTurn(native('stop', { status: 'error' }))).toBeNull();
    expect(await cursorTurn({ hook_event_name: 'stop', text: 'x' })).toBeNull();
    expect(await cursorTurn(native('afterAgentResponse', { text: '  ', transcript_path: null }))).toBeNull();
  });
});

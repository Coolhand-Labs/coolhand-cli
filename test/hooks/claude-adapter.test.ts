import { promises as fs } from 'fs';
import * as path from 'path';
import { claudeTurn } from '../../src/hooks/adapters/claude.js';
import { extractLastTurn } from '../../src/sessions/claude-scanner.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (requestId: string, content: unknown[], model = 'm-1') => ({
  type: 'assistant',
  requestId,
  message: { id: `msg-${requestId}`, role: 'assistant', model, content },
});

describe('extractLastTurn', () => {
  it('returns the latest real prompt and the final assistant text only', () => {
    const turn = extractLastTurn(
      lines(
        user('first question'),
        assistant('r0', [{ type: 'text', text: 'first answer' }]),
        user('second question'),
        user('INJECTED', { isMeta: true }),
        assistant('r1', [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'tool_use', name: 'Bash', input: {} }]),
        user([{ type: 'tool_result', tool_use_id: 't', content: 'output' }]),
        assistant('r2', [{ type: 'text', text: 'second answer' }], 'm-2')
      )
    );
    expect(turn).toEqual({ userText: 'second question', assistantText: 'second answer', model: 'm-2', assistantKey: 'r2' });
  });

  it('takes the text blocks of an array prompt and skips malformed lines', () => {
    const turn = extractLastTurn(
      `{"partial line cut by the tail read\n${lines(user([{ type: 'text', text: 'from blocks' }]), assistant('r1', [{ type: 'text', text: 'ok' }]))}\nnot json`
    );
    expect(turn.userText).toBe('from blocks');
    expect(turn.assistantText).toBe('ok');
  });

  it('ignores subagent (sidechain) traffic and interrupt markers', () => {
    const turn = extractLastTurn(
      lines(
        user('real question'),
        user('subagent prompt', { isSidechain: true }),
        { ...assistant('r1', [{ type: 'text', text: 'subagent answer' }]), isSidechain: true },
        user('[Request interrupted by user]'),
        assistant('r2', [{ type: 'text', text: 'the real answer' }])
      )
    );
    expect(turn.userText).toBe('real question');
    expect(turn.assistantText).toBe('the real answer');
    expect(turn.assistantKey).toBe('r2');
  });

  it('ignores the pseudo-model Claude Code puts on its own placeholder messages', () => {
    const turn = extractLastTurn(
      lines(user('go'), assistant('r1', [{ type: 'text', text: 'answer' }], 'real-model'), assistant('r2', [{ type: 'text', text: 'API Error' }], '<synthetic>'))
    );
    expect(turn.model).toBe('real-model');
  });

  it.each([
    [
      'name, message and args in the order Claude Code writes them',
      '<command-message>loop-review</command-message>\n<command-name>/loop-review</command-name>\n<command-args>high --max-rounds 3</command-args>',
      '/loop-review high --max-rounds 3',
    ],
    [
      'args first-class and multiline, tags in the other order',
      '<command-name>/api-harness</command-name>\n  <command-message>api-harness</command-message>\n  <command-args>Build the docs & search\nthen reopen #178</command-args>',
      '/api-harness Build the docs & search\nthen reopen #178',
    ],
    ['no args tag at all', '<command-message>loop-review</command-message>\n<command-name>/loop-review</command-name>', '/loop-review'],
    ['an empty args tag', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', '/compact'],
    ['only the message tag', '<command-message>loop-review</command-message>', '/loop-review'],
  ])('records a typed slash command as what the user typed: %s', (_label, raw, expected) => {
    const turn = extractLastTurn(lines(user(raw), assistant('r1', [{ type: 'text', text: 'ok' }])));
    expect(turn.userText).toBe(expected);
  });

  it('leaves an ordinary prompt that merely mentions a command tag alone', () => {
    const prompt = 'why does <command-args> show up in my transcript?';
    expect(extractLastTurn(lines(user(prompt), assistant('r1', [{ type: 'text', text: 'ok' }]))).userText).toBe(prompt);
  });

  it('does not take a compaction summary, or a tool-result line with extra text, for a prompt', () => {
    const turn = extractLastTurn(
      lines(
        user('real prompt'),
        user('A very long summary of the conversation so far...', { isCompactSummary: true }),
        user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }, { type: 'text', text: 'system reminder text' }]),
        assistant('r1', [{ type: 'text', text: 'the answer' }])
      )
    );
    expect(turn.userText).toBe('real prompt');
    expect(turn.assistantText).toBe('the answer');
  });

  it('does not pair a reply with the previous prompt when the new prompt has no text', () => {
    const turn = extractLastTurn(
      lines(
        user('earlier question'),
        assistant('r1', [{ type: 'text', text: 'earlier answer' }]),
        user([{ type: 'image', source: {} }]),
        assistant('r2', [{ type: 'text', text: 'about the picture' }])
      )
    );
    expect(turn.userText).toBeUndefined();
    expect(turn.assistantText).toBe('about the picture');
  });

  it('reports the request id of the message the text came from, not a later tool-only one', () => {
    const turn = extractLastTurn(
      lines(
        user('go'),
        assistant('r1', [{ type: 'text', text: 'working on it' }]),
        assistant('r2', [{ type: 'tool_use', name: 'Bash', input: {} }])
      )
    );
    expect(turn.assistantText).toBe('working on it');
    expect(turn.assistantKey).toBe('r1');
  });

  it('has no assistant text, and no key, when the turn ended in tool use', () => {
    const turn = extractLastTurn(lines(user('go'), assistant('r1', [{ type: 'tool_use', name: 'Bash', input: {} }])));
    expect(turn.userText).toBe('go');
    expect(turn.assistantText).toBeUndefined();
    expect(turn.assistantKey).toBeUndefined();
  });
});

describe('claudeTurn', () => {
  let home: TmpHome;
  beforeEach(async () => {
    home = await createTmpHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('prefers last_assistant_message and reads the user prompt from the transcript tail', async () => {
    const file = path.join(home.dir, 't.jsonl');
    await fs.writeFile(file, lines(user('the prompt'), assistant('r1', [{ type: 'text', text: 'from transcript' }])));
    const turn = await claudeTurn({
      hook_event_name: 'Stop',
      session_id: 's1',
      transcript_path: file,
      cwd: '/w',
      last_assistant_message: 'from payload',
    });
    expect(turn).toEqual({
      sessionId: 's1',
      userText: 'the prompt',
      assistantText: 'from payload',
      model: 'm-1',
      turnKey: undefined, // the transcript's reply differs from the payload's, so its request id isn't trusted
      cwd: '/w',
    });
  });

  it('trusts the transcript request id when it is for the same reply', async () => {
    const file = path.join(home.dir, 't.jsonl');
    await fs.writeFile(file, lines(user('q'), assistant('r9', [{ type: 'text', text: 'same reply' }])));
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'same reply' });
    expect(turn?.turnKey).toBe('r9');
  });

  it('still finds the turn when the transcript is larger than the 4 MB tail it reads', async () => {
    const file = path.join(home.dir, 'big.jsonl');
    const hugeResult = user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(4.5 * 1024 * 1024) }]);
    await fs.writeFile(file, lines(hugeResult, user('the prompt after a huge tool result'), assistant('r1', [{ type: 'text', text: 'a' }])));

    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'a' });

    expect(turn?.userText).toBe('the prompt after a huge tool result');
  });

  it('falls back to the transcript when the payload has no message', async () => {
    const file = path.join(home.dir, 't.jsonl');
    await fs.writeFile(file, lines(user('q'), assistant('r1', [{ type: 'text', text: 'a' }])));
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file });
    expect(turn?.assistantText).toBe('a');
  });

  it('returns null for other events and for payloads with nothing to send', async () => {
    expect(await claudeTurn({ hook_event_name: 'SessionStart', session_id: 's1', last_assistant_message: 'x' })).toBeNull();
    expect(await claudeTurn({ hook_event_name: 'Stop', last_assistant_message: 'x' })).toBeNull();
    expect(await claudeTurn({ hook_event_name: 'Stop', session_id: 's1' })).toBeNull();
  });
});

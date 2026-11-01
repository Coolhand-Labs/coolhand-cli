import { promises as fs } from 'fs';
import * as path from 'path';
import { claudeTurn } from '../../src/hooks/adapters/claude.js';
import { extractLastTurn, parseExchanges } from '../../src/sessions/claude-scanner.js';
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

  it('leaves a prompt that quotes the slash-command markup mid-text alone', () => {
    const prompt = 'Debugging a transcript: the line was <command-name>/foo</command-name> with <command-args>bar</command-args>';
    expect(extractLastTurn(lines(user(prompt), assistant('r1', [{ type: 'text', text: 'ok' }]))).userText).toBe(prompt);
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

describe('parseExchanges', () => {
  it('strips text the harness injected into user lines: never typed, and re-uploaded every turn otherwise', () => {
    const { exchanges } = parseExchanges(
      lines(
        user('<task-notification>\n<task-id>abc</task-id>\n<summary>background job finished in /Users/me/secret</summary>\n</task-notification>'),
        user('Please review this.\n<system_instruction>You are working inside Conductor in /Users/me/workspaces/x</system_instruction>'),
        assistant('r1', [{ type: 'text', text: 'ok' }]),
        user([
          { type: 'text', text: '<ide_opened_file>The user opened /Users/me/private.ts in the IDE</ide_opened_file>' },
          { type: 'text', text: '<ide_selection>const apiKey = "x"</ide_selection>' },
          { type: 'text', text: 'what does this do?' },
        ]),
        assistant('r2', [{ type: 'text', text: 'it does a thing' }]),
        user('typed text <system-reminder>never closed, so everything after it goes'),
        user('<system-reminder>a whole line of reminder</system-reminder>')
      )
    );
    expect(exchanges.map((e) => [e.userText, e.assistantText])).toEqual([
      ['Please review this.', 'ok'],
      ['what does this do?', 'it does a thing'],
      ['typed text', undefined],
    ]);
    expect(JSON.stringify(exchanges)).not.toMatch(/Users\/me|secret|apiKey|never closed|Conductor/);
  });

  it('strips injected context in linear time, even from a huge line of unclosed tags', () => {
    const hostile = '<system-reminder>x'.repeat(60_000); // ~1 MB of openers that never close
    const started = Date.now();
    const { exchanges } = parseExchanges(lines(user(`typed first ${hostile}`), user(`${'<ide_selection>a</ide_selection> '.repeat(30_000)}typed last`)));

    expect(Date.now() - started).toBeLessThan(2000);
    expect(exchanges.map((e) => e.userText)).toEqual(['typed first', 'typed last']);
  });

  it('strips the caveat and prompt-submit-hook blocks too, keeping what was typed', () => {
    const { exchanges } = parseExchanges(
      lines(
        user('Caveat: <local-command-caveat>The messages below were generated by the user while running local commands. /Users/me/x</local-command-caveat>\nreal question'),
        user('another <user-prompt-submit-hook>Hook output: token abc123 in /Users/me</user-prompt-submit-hook>one')
      )
    );
    expect(exchanges.map((e) => e.userText)).toEqual(['Caveat: \nreal question', 'another one']);
    expect(JSON.stringify(exchanges)).not.toMatch(/Users\/me|abc123|generated by the user/);
  });

  it('sums the main thread\'s token usage once per message, however many block lines repeat it', () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
    const withUsage = (id: string, blocks: unknown[]) => ({ ...assistant(id, blocks), message: { ...assistant(id, blocks).message, usage } });
    const { exchanges } = parseExchanges(
      lines(
        user('one'),
        withUsage('r1', [{ type: 'thinking', thinking: 'hm' }]),
        withUsage('r1', [{ type: 'tool_use', name: 'Bash', input: {} }]), // same message, next content block
        user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }]),
        withUsage('r2', [{ type: 'text', text: 'done' }]),
        { ...withUsage('r3', [{ type: 'text', text: 'a subagent' }]), isSidechain: true }, // not the main thread
        user('two'),
        assistant('r4', [{ type: 'text', text: 'no usage reported' }])
      )
    );
    expect(exchanges[0].usage).toEqual({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 40 });
    expect(exchanges[1].usage).toBeUndefined();
  });

  it('reads subagent totals from Agent tool results, per model, once per run', () => {
    const agentUsage = { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 9, service_tier: 'standard' };
    const result = (agentId: string, resolvedModel: string) => ({
      ...user([{ type: 'tool_result', tool_use_id: agentId, content: 'report' }]),
      toolUseResult: { status: 'completed', agentId, resolvedModel, usage: agentUsage, totalTokens: 69 },
    });
    const { exchanges } = parseExchanges(
      lines(
        user('review this'),
        result('a1', 'sonnet-x'),
        result('a1', 'sonnet-x'), // the same run reported twice
        result('a2', 'opus-y'),
        { ...result('a3', 'ignored'), isSidechain: true },
        assistant('r1', [{ type: 'text', text: 'reviewed' }])
      )
    );
    const sub = exchanges[0].subagents!;
    expect(sub.calls).toBe(2);
    expect(sub.total).toEqual({ input_tokens: 6, output_tokens: 14, cache_read_input_tokens: 100, cache_creation_input_tokens: 18 });
    expect(Object.keys(sub.by_model).sort()).toEqual(['opus-y', 'sonnet-x']);
    expect(sub.by_model['opus-y'].output_tokens).toBe(7);
  });

  it("keeps an exchange's whole message sequence: one assistant message per model call, tool results as user messages", () => {
    const { exchanges } = parseExchanges(
      lines(
        user('go'),
        assistant('r1', [{ type: 'thinking', thinking: 'I should list files.', signature: 'sig' }]),
        assistant('r1', [{ type: 'text', text: 'Let me look.' }]), // same model call, next content-block line
        assistant('r1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]),
        user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'a\nb' }, { type: 'text', text: 'a system reminder riding along' }]),
        { ...assistant('side', [{ type: 'text', text: 'a subagent talking' }]), isSidechain: true },
        { ...user('Base directory for this skill: /x/y\n\nbody'), isMeta: true },
        user('<task-notification>background job done</task-notification>'),
        assistant('r2', [{ type: 'text', text: 'Two files.' }])
      )
    );
    const messages = exchanges[0].messages!;
    expect(messages.map((m) => [m.role, m.blocks.map((b) => (b as { type: string }).type)])).toEqual([
      ['assistant', ['thinking', 'text', 'tool_use']],
      ['user', ['tool_result']], // the reminder text that rode along is not part of it
      ['assistant', ['text']],
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/subagent|reminder|Base directory|background job/);
  });

  it('keeps the skill body Claude Code injects after a slash command out of the prompts, and reads it', () => {
    const { exchanges } = parseExchanges(
      lines(
        user('<command-message>qa-login</command-message>\n<command-name>/qa-login</command-name>'),
        { ...user('Base directory for this skill: /Users/me/.claude/skills/qa-login\n\n# QA login\nRun the checks.'), isMeta: true },
        { ...user('some other injected context'), isMeta: true },
        assistant('r1', [{ type: 'text', text: 'starting' }])
      )
    );
    expect(exchanges.map((e) => e.userText)).toEqual(['/qa-login']);
    expect(exchanges[0].skill).toEqual({ dir: '/Users/me/.claude/skills/qa-login', text: '# QA login\nRun the checks.' });
  });

  it('still counts an image-only prompt as a prompt, but not a line that was nothing but injected context', () => {
    const { exchanges } = parseExchanges(
      lines(
        user([{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>' }]),
        user([{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>' }, { type: 'image', source: {} }]),
        assistant('r1', [{ type: 'text', text: 'a picture' }])
      )
    );
    expect(exchanges.map((e) => [e.userText, e.assistantText])).toEqual([[undefined, 'a picture']]);
  });

  it('never treats the output of a local command or of bash mode as something the user typed', () => {
    const { exchanges } = parseExchanges(
      lines(
        user('a real question'),
        assistant('r1', [{ type: 'text', text: 'a real answer' }]),
        user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
        user('<local-command-stdout>Compacted. account: someone@example.com, mcp: secret-server</local-command-stdout>'),
        user('<bash-input>cat ~/.aws/credentials</bash-input>'),
        user('<bash-stdout>aws_secret_access_key = abc</bash-stdout>'),
        user('  <local-command-stderr>oops</local-command-stderr>')
      )
    );
    expect(exchanges.map((e) => e.userText)).toEqual(['a real question', '/compact']);
    expect(JSON.stringify(exchanges)).not.toMatch(/someone@example|secret-server|aws_secret|credentials|oops/);
  });

  it("records when each exchange's user line was written", () => {
    const { exchanges } = parseExchanges(
      lines(
        { ...user('one'), timestamp: '2026-10-28T10:00:00.000Z' },
        assistant('r1', [{ type: 'text', text: 'a' }]),
        { ...user('two'), timestamp: '2026-10-28T10:00:05.000Z' }
      )
    );
    expect(exchanges.map((e) => e.timestamp)).toEqual(['2026-10-28T10:00:00.000Z', '2026-10-28T10:00:05.000Z']);
  });

  it('returns every exchange in order, merging tool loops into one reply per prompt', () => {
    const { exchanges, model } = parseExchanges(
      lines(
        user('first question'),
        assistant('r1', [{ type: 'tool_use', name: 'Bash', input: {} }]),
        user([{ type: 'tool_result', tool_use_id: 't', content: 'output' }]),
        assistant('r2', [{ type: 'text', text: 'first answer' }], 'm-1'),
        user('second question'),
        assistant('r3', [{ type: 'text', text: 'second answer' }], 'm-2')
      )
    );
    expect(exchanges.map((e) => [e.userText, e.assistantText])).toEqual([
      ['first question', 'first answer'],
      ['second question', 'second answer'],
    ]);
    expect(model).toBe('m-2');
  });

  it('keeps an unanswered prompt and a textless prompt as exchanges of their own', () => {
    const { exchanges } = parseExchanges(lines(user('never answered'), user([{ type: 'image', source: {} }]), assistant('r1', [{ type: 'text', text: 'about the picture' }])));
    expect(exchanges.map((e) => [e.userText, e.assistantText])).toEqual([
      ['never answered', undefined],
      [undefined, 'about the picture'],
    ]);
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
    expect(turn).toMatchObject({
      sessionId: 's1',
      userText: 'the prompt',
      assistantText: 'from payload',
      model: 'm-1',
      turnKey: undefined, // the transcript's reply differs from the payload's, so its request id isn't trusted
      cwd: '/w',
      earlier: [],
      earlierStamps: [],
      skillBodies: [],
    });
    // The reply differs from the payload's, so the transcript hasn't caught up: its message stays in the loop.
    expect(turn?.finalReply).toBeUndefined();
    expect(turn?.currentMessages).toHaveLength(1);
  });

  it('trusts the transcript request id when it is for the same reply', async () => {
    const file = path.join(home.dir, 't.jsonl');
    await fs.writeFile(file, lines(user('q'), assistant('r9', [{ type: 'text', text: 'same reply' }])));
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'same reply' });
    expect(turn?.turnKey).toBe('r9');
  });

  it('still finds the turn when the transcript is larger than the 8 MB window it reads', async () => {
    const file = path.join(home.dir, 'big.jsonl');
    const hugeResult = user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(9 * 1024 * 1024) }]);
    await fs.writeFile(file, lines(hugeResult, user('the prompt after a huge tool result'), assistant('r1', [{ type: 'text', text: 'a' }])));

    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'a' });

    expect(turn?.userText).toBe('the prompt after a huge tool result');
  });

  it('still trusts the request id when a multi-block reply is joined differently in the payload', async () => {
    const file = path.join(home.dir, 'multi.jsonl');
    await fs.writeFile(
      file,
      lines(user('q'), assistant('r7', [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }]))
    );
    const turn = await claudeTurn({
      session_id: 's1',
      transcript_path: file,
      last_assistant_message: 'first part\n\nsecond part',
    });
    expect(turn?.turnKey).toBe('r7');
  });

  it('hands back when each exchange was written, for anchoring the history', async () => {
    const file = path.join(home.dir, 'stamped.jsonl');
    await fs.writeFile(
      file,
      lines(
        { ...user('one'), timestamp: '2026-10-28T10:00:00.000Z' },
        assistant('r1', [{ type: 'text', text: 'reply one' }]),
        { ...user('two'), timestamp: '2026-10-28T10:00:05.000Z' },
        assistant('r2', [{ type: 'text', text: 'reply two' }])
      )
    );
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'reply two' });

    expect(turn?.exchangeTimestamp).toBe('2026-10-28T10:00:05.000Z');
    expect(turn?.earlier?.map((e) => [e.timestamp, e.userText, e.assistantText])).toEqual([['2026-10-28T10:00:00.000Z', 'one', 'reply one']]);
  });

  it("splits this turn into its tool loop and its final reply (thinking and text) when the transcript shows the reply", async () => {
    const file = path.join(home.dir, 'loop.jsonl');
    await fs.writeFile(
      file,
      lines(
        user('list the files'),
        assistant('r1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]),
        user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'a\nb' }]),
        assistant('r2', [{ type: 'thinking', thinking: 'Two files.', signature: 'sig' }, { type: 'text', text: 'There are two files.' }])
      )
    );
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'There are two files.' });

    expect(turn?.currentMessages?.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(turn?.finalReply?.map((b) => (b as { type: string }).type)).toEqual(['thinking', 'text']);
  });

  it("keeps the whole loop as the request, and sends the hook's own text as the reply, while the transcript hasn't caught up", async () => {
    const file = path.join(home.dir, 'mid-loop.jsonl');
    await fs.writeFile(
      file,
      lines(user('list the files'), assistant('r1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]), user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'a' }]))
    );
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'The reply being given now.' });

    expect(turn?.currentMessages).toHaveLength(2);
    expect(turn?.finalReply).toBeUndefined();
  });

  it('hands back the earlier exchanges (not the current one), oldest first', async () => {
    const file = path.join(home.dir, 'history.jsonl');
    await fs.writeFile(
      file,
      lines(
        user('one'),
        assistant('r1', [{ type: 'text', text: 'reply one' }]),
        user('two'),
        assistant('r2', [{ type: 'tool_use', name: 'Bash', input: {} }]),
        user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }]),
        assistant('r3', [{ type: 'text', text: 'reply two' }]),
        { ...user('subagent prompt'), isSidechain: true },
        user('three'),
        assistant('r4', [{ type: 'text', text: 'reply three' }])
      )
    );
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'reply three' });

    expect(turn?.userText).toBe('three');
    expect(turn?.earlier?.map((e) => [e.userText, e.assistantText])).toEqual([
      ['one', 'reply one'],
      ['two', 'reply two'],
    ]);
    // What happened inside the second exchange is kept too: the tool call, its result, the reply.
    expect(turn?.earlier?.[1].messages?.map((m) => [m.role, m.blocks.map((b) => (b as { type: string }).type)])).toEqual([
      ['assistant', ['tool_use']],
      ['user', ['tool_result']],
      ['assistant', ['text']],
    ]);
  });

  it('does not name the latest transcript exchange as this turn while the transcript has not caught up with the reply', async () => {
    const file = path.join(home.dir, 'lagging.jsonl');
    await fs.writeFile(
      file,
      lines(
        { ...user('an earlier, pre-skill prompt'), timestamp: '2026-10-28T10:00:00.000Z' },
        assistant('r1', [{ type: 'text', text: 'its reply' }])
      )
    );
    // The hook is for a turn whose prompt and reply are not in the transcript yet.
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'the reply being given now' });

    expect(turn?.exchangeTimestamp).toBeUndefined();
  });

  it("trusts the latest exchange as this turn when it has the prompt and the reply hasn't been written yet", async () => {
    const file = path.join(home.dir, 'prompt-only.jsonl');
    await fs.writeFile(file, lines({ ...user('/qa-login'), timestamp: '2026-10-28T10:00:00.000Z' }));
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'starting' });

    expect(turn?.userText).toBe('/qa-login');
    expect(turn?.exchangeTimestamp).toBe('2026-10-28T10:00:00.000Z');
  });

  it('reports the timestamp of earlier exchanges that have no text of their own', async () => {
    const file = path.join(home.dir, 'image.jsonl');
    await fs.writeFile(
      file,
      lines(
        { ...user([{ type: 'image', source: {} }]), timestamp: '2026-10-28T10:00:00.000Z' },
        assistant('r1', [{ type: 'text', text: 'a picture' }]),
        { ...user('next'), timestamp: '2026-10-28T10:00:05.000Z' },
        assistant('r2', [{ type: 'text', text: 'ok' }])
      )
    );
    const turn = await claudeTurn({ session_id: 's1', transcript_path: file, last_assistant_message: 'ok' });

    expect(turn?.earlier).toEqual([]); // nothing to send for an image-only prompt…
    expect(turn?.earlierStamps).toEqual(['2026-10-28T10:00:00.000Z']); // …but it is still in view
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

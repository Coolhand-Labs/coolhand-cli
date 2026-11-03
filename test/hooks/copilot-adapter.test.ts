import { promises as fs } from 'fs';
import * as path from 'path';
import { copilotTurn } from '../../src/hooks/adapters/copilot.js';
import { parseCopilotExchanges } from '../../src/sessions/copilot-scanner.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';
import { FIXTURES, events, recordedHook, recordedTranscriptBefore } from '../helpers/copilot-transcript.js';

/** These run on payloads and transcripts recorded from real VS Code Copilot sessions (test/fixtures/copilot). */

describe('parseCopilotExchanges (recorded skill session)', () => {
  it('reads three exchanges, the first carrying the skill invocation, its tool loop and its usage', async () => {
    const parsed = parseCopilotExchanges(await fs.readFile(path.join(FIXTURES, 'skill-session.events.jsonl'), 'utf8'));

    expect(parsed.exchanges.map((e) => e.userText)).toEqual([
      '/qa-spike',
      'Next: read package.json and tell me the package name.',
      'Summarise turns 1 and 2 in one sentence.',
    ]);
    const first = parsed.exchanges[0];
    expect(first.skills?.map((x) => x.name)).toEqual(['qa-spike']);
    expect(first.skills?.[0].dir).toBe('/Users/tester/project/.github/skills/qa-spike');
    expect(first.assistantText).toBe('wite');
    expect(first.messages?.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(first.messages?.[0].blocks).toEqual([
      { type: 'tool_use', id: expect.any(String), name: 'rename_chat', input: { title: 'QA hook payload spike', automatic: true } },
      { type: 'tool_use', id: expect.any(String), name: 'ask_user', input: expect.objectContaining({ message: expect.any(String) }) },
    ]);
    // Both tool results arrive as one user message of two blocks.
    expect(first.messages?.[1].blocks).toHaveLength(2);
    expect(first.messages?.[1].blocks[1]).toMatchObject({ type: 'tool_result', content: 'User responded: wite', is_error: false });
    // Copilot's inputTokens include the cached tokens; the usage is split the way Claude's is.
    expect(first.usage).toMatchObject({ cache_read_input_tokens: 8572 + 17853, cache_creation_input_tokens: 9281 + 300 });
    expect(first.usage!.input_tokens).toBe(17856 - 8572 - 9281 + (18156 - 17853 - 300));
    expect(parsed.model).toBe('gpt-6-luna');
  });

  it('has no skill invocation in the unrelated chat', async () => {
    const parsed = parseCopilotExchanges(await fs.readFile(path.join(FIXTURES, 'unrelated-session.events.jsonl'), 'utf8'));
    expect(parsed.exchanges).toHaveLength(1);
    expect(parsed.exchanges[0]).toMatchObject({ userText: 'what is 2+2?', assistantText: '4' });
    expect(parsed.exchanges.some((e) => e.skills)).toBe(false);
  });

  it('skips garbage lines and never throws', () => {
    expect(parseCopilotExchanges('not json\n{"type":"user.message"\n\n{"type":"user.message","data":null}')).toEqual({ exchanges: [], model: undefined });
  });
});

describe('copilotTurn (recorded payloads)', () => {
  let home: TmpHome;
  let transcript: string;

  beforeEach(async () => {
    home = await createTmpHome();
    transcript = path.join(home.dir, 'events.jsonl');
  });
  afterEach(() => home.cleanup());

  const writeSkillSession = async (userMessages: number) =>
    fs.writeFile(transcript, await recordedTranscriptBefore('skill-session.events.jsonl', userMessages + 1));

  it('turns the first Stop of a skill session into the invoking turn, with the skill body', async () => {
    await writeSkillSession(1);
    const turn = await copilotTurn(await recordedHook('hook-Stop-1.json', transcript), { skill: 'qa-spike' });

    expect(turn).toMatchObject({
      sessionId: 'fdea4f81-9f13-4808-a9fa-bdedb5a926b5',
      userText: '/qa-spike',
      assistantText: 'wite',
      model: 'gpt-6-luna',
      cwd: '/Users/tester/project',
      earlier: [],
    });
    expect(turn?.exchangeTimestamp).toBeDefined();
    expect(turn?.skillBodies?.[0]).toMatchObject({ dir: '/Users/tester/project/.github/skills/qa-spike' });
    expect(turn?.finalReply).toEqual([{ type: 'text', text: 'wite' }]);
    expect(turn?.currentMessages?.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('adds the conversation so far on the second turn, whose prompt has no skill markup of its own', async () => {
    await writeSkillSession(2);
    const turn = await copilotTurn(await recordedHook('hook-Stop-2.json', transcript), { skill: 'qa-spike' });

    expect(turn).toMatchObject({ userText: 'Next: read package.json and tell me the package name.', assistantText: 'The package name is `coolhand-cli`.' });
    expect(turn?.earlier).toHaveLength(1);
    expect(turn?.earlier?.[0]).toMatchObject({ userText: '/qa-spike', assistantText: 'wite' });
    expect(turn?.currentMessages?.[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'view' });
  });

  it('understands the camelCase spelling of the payload (agentStop)', async () => {
    await writeSkillSession(1);
    const turn = await copilotTurn(
      { sessionId: 'sess-camel', transcriptPath: transcript, cwd: '/x', stopReason: 'end_turn' },
      { skill: 'qa-spike' }
    );
    expect(turn).toMatchObject({ sessionId: 'sess-camel', assistantText: 'wite' });
    expect(await copilotTurn({ hook_event_name: 'agentStop', session_id: 's', transcript_path: transcript }, { skill: 'qa-spike' })).not.toBeNull();
  });

  it('sends nothing for a chat that never invoked the skill', async () => {
    await fs.writeFile(transcript, await fs.readFile(path.join(FIXTURES, 'unrelated-session.events.jsonl')));
    expect(await copilotTurn(await recordedHook('hook-Stop-4.json', transcript), { skill: 'qa-spike' })).toBeNull();
  });

  it('sends nothing for another skill, without --skill, for other events, or without a readable transcript', async () => {
    await writeSkillSession(1);
    const stop = await recordedHook('hook-Stop-1.json', transcript);
    expect(await copilotTurn(stop, { skill: 'some-other-skill' })).toBeNull();
    expect(await copilotTurn(stop, {})).toBeNull();
    expect(await copilotTurn(stop)).toBeNull();
    for (const name of ['hook-UserPromptSubmit-1.json', 'hook-PreToolUse-1.json', 'hook-PostToolUse-1.json', 'hook-SessionStart-1.json']) {
      expect(await copilotTurn(await recordedHook(name, transcript), { skill: 'qa-spike' })).toBeNull();
    }
    expect(await copilotTurn({ ...stop, transcript_path: path.join(home.dir, 'missing.jsonl') }, { skill: 'qa-spike' })).toBeNull();
    // An unreadable transcript is a fault, not a quiet chat, so it is logged.
    expect(await fs.readFile(path.join(home.dir, 'capture-turns', 'hook.log'), 'utf8')).toContain('could not read the transcript: ENOENT');
    expect(await copilotTurn({ ...stop, session_id: undefined }, { skill: 'qa-spike' })).toBeNull();
  });

  it('matches the skill by its directory name when the declared name differs', async () => {
    await fs.writeFile(transcript, [events.skill('Pretty Name', '/w/.github/skills/qa-dir'), events.user('/go'), events.assistant('done')].join('\n'));
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa-dir' })).toMatchObject({ assistantText: 'done' });
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'Pretty Name' })).not.toBeNull();
  });

  it('resolves a --skill pattern to the first matching skill invoked, and ignores skills outside it', async () => {
    await fs.writeFile(
      transcript,
      [events.skill('acme-first'), events.user('/acme-first'), events.assistant('one'), events.skill('acme-second'), events.user('/acme-second'), events.assistant('two')].join('\n')
    );
    const stop = { session_id: 's', transcript_path: transcript };
    expect(await copilotTurn(stop, { skill: '*' })).toMatchObject({ skill: 'acme-first', assistantText: 'two' });
    expect(await copilotTurn(stop, { skill: 'acme-*' })).toMatchObject({ skill: 'acme-first' });
    expect(await copilotTurn(stop, { skill: 'acme-s*' })).toMatchObject({ skill: 'acme-second' });
    expect(await copilotTurn(stop, { skill: 'other-*' })).toBeNull();
    // A plain name is still exact, and resolves to itself.
    expect(await copilotTurn(stop, { skill: 'acme-second' })).toMatchObject({ skill: 'acme-second' });
    expect(await copilotTurn(stop, { skill: 'acme' })).toBeNull();
  });

  it('sends nothing under a --skill pattern for a chat that invoked no skill', async () => {
    await fs.writeFile(transcript, [events.user('hello'), events.assistant('hi')].join('\n'));
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: '*' })).toBeNull();
  });

  it('waits for a reply the transcript has not caught up with yet', async () => {
    await fs.writeFile(transcript, [events.skill('qa'), events.user('/qa')].join('\n') + '\n');
    setTimeout(() => void fs.appendFile(transcript, events.assistant('late reply') + '\n'), 120);

    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa' })).toMatchObject({ assistantText: 'late reply' });
  });

  it('gives up on a reply that never arrives, and does not wait at all for a chat without the skill', async () => {
    await fs.writeFile(transcript, [events.skill('qa'), events.user('/qa')].join('\n') + '\n');
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa' })).toBeNull();

    await fs.writeFile(transcript, events.user('hello') + '\n');
    const started = Date.now();
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa' })).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('skills loaded by the model, tool failures and usage kinds', () => {
  let home: TmpHome;
  let transcript: string;

  beforeEach(async () => {
    home = await createTmpHome();
    transcript = path.join(home.dir, 'events.jsonl');
  });
  afterEach(() => home.cleanup());

  const skillEvent = (trigger: string) =>
    JSON.stringify({ type: 'skill.invoked', timestamp: '2026-11-02T12:00:05.000Z', data: { name: 'qa', path: '/w/.github/skills/qa/SKILL.md', content: '# qa', trigger } });

  it('attaches a skill the model loaded mid-turn to that turn, not to the next prompt', () => {
    const parsed = parseCopilotExchanges(
      [events.user('please run the qa checklist'), skillEvent('model-invoked'), events.assistant('running it'), events.user('and now?')].join('\n')
    );
    expect(parsed.exchanges[0].skills?.map((x) => x.name)).toEqual(['qa']);
    expect(parsed.exchanges[1].skills).toBeUndefined();
  });

  it('still attaches a skill the user typed to the prompt that follows it', () => {
    const parsed = parseCopilotExchanges([events.user('earlier'), skillEvent('user-invoked'), events.user('/qa')].join('\n'));
    expect(parsed.exchanges.map((e) => e.skills?.map((x) => x.name))).toEqual([undefined, ['qa']]);
  });

  it('sends the turn in which the model loaded the skill', async () => {
    await fs.writeFile(transcript, [events.user('please run the qa checklist'), skillEvent('model-invoked'), events.assistant('checklist started')].join('\n'));
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa' })).toMatchObject({ assistantText: 'checklist started' });
  });

  it('reports the declared name beside the directory so the skill text can be found by either', async () => {
    await fs.writeFile(transcript, [events.skill('Pretty Name', '/w/.github/skills/qa-dir'), events.user('/go'), events.assistant('done')].join('\n'));
    const turn = await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'Pretty Name' });
    expect(turn?.skillBodies?.[0]).toMatchObject({ name: 'Pretty Name', dir: '/w/.github/skills/qa-dir' });
  });

  it('keeps the error text of a failed tool call, also when the content field is empty', () => {
    const failed = JSON.stringify({ type: 'tool.execution_complete', timestamp: '2026-11-02T12:00:06.000Z', data: { toolCallId: 'c', success: false, result: { content: '', error: { message: 'permission denied' } } } });
    const parsed = parseCopilotExchanges([events.user('go'), events.assistant('', [{ toolCallId: 'c', name: 'run', arguments: {} }]), failed].join('\n'));
    expect(parsed.exchanges[0].messages?.[1].blocks[0]).toMatchObject({ type: 'tool_result', content: 'permission denied', is_error: true });
  });

  it("counts only the conversation's own model calls toward a turn's usage", () => {
    const usage = (interactionType: string, inputTokens: number) =>
      JSON.stringify({ type: 'session.usage_record', timestamp: '2026-11-02T12:00:07.000Z', data: { usage: { interactionType, inputTokens, outputTokens: 1 } } });
    const parsed = parseCopilotExchanges([events.user('go'), usage('conversation-agent', 10), usage('title-generation', 1000), events.assistant('ok')].join('\n'));
    expect(parsed.exchanges[0].usage).toMatchObject({ input_tokens: 10, output_tokens: 1 });
  });

  it('recognises the skill when another one was typed first and the model then loaded this one', async () => {
    const typed = JSON.stringify({ type: 'skill.invoked', timestamp: '2026-11-02T12:00:00.000Z', data: { name: 'other', path: '/w/.github/skills/other/SKILL.md', content: '# other', trigger: 'user-invoked' } });
    await fs.writeFile(transcript, [typed, events.user('/other'), skillEvent('model-invoked'), events.assistant('both loaded')].join('\n'));

    const turn = await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa' });
    expect(turn).toMatchObject({ assistantText: 'both loaded' });
    expect(turn?.skillBodies?.map((b) => b.name)).toEqual(['other', 'qa']);
  });

  it('keeps two skills typed before one prompt', () => {
    const typed = (name: string) => JSON.stringify({ type: 'skill.invoked', timestamp: '2026-11-02T12:00:00.000Z', data: { name, path: `/w/.github/skills/${name}/SKILL.md`, content: name, trigger: 'user-invoked' } });
    const parsed = parseCopilotExchanges([typed('a'), typed('b'), events.user('/a /b')].join('\n'));
    expect(parsed.exchanges[0].skills?.map((x) => x.name)).toEqual(['a', 'b']);
  });
});

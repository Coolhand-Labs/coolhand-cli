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
    expect(first.skillName).toBe('qa-spike');
    expect(first.skill?.dir).toBe('/Users/tester/project/.github/skills/qa-spike');
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
    expect(parsed.exchanges.some((e) => e.skillName)).toBe(false);
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
    expect(await copilotTurn({ ...stop, session_id: undefined }, { skill: 'qa-spike' })).toBeNull();
  });

  it('matches the skill by its directory name when the declared name differs', async () => {
    await fs.writeFile(transcript, [events.skill('Pretty Name', '/w/.github/skills/qa-dir'), events.user('/go'), events.assistant('done')].join('\n'));
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'qa-dir' })).toMatchObject({ assistantText: 'done' });
    expect(await copilotTurn({ session_id: 's', transcript_path: transcript }, { skill: 'Pretty Name' })).not.toBeNull();
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

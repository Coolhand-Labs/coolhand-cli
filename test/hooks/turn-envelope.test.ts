import { buildTurnEnvelope, HISTORY_BUDGET_CHARS, MAX_TURN_TEXT_CHARS, prepareTurnMessages } from '../../src/sessions/turn-envelope.js';
import type { HookTurn } from '../../src/hooks/types.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

/** A transcript timestamp `n` seconds into the session. */
const at = (n: number) => `2026-10-28T10:00:${String(n).padStart(2, '0')}.000Z`;
/** By default every exchange the transcript shows counts as captured by a hook; tests that care say otherwise. */
const allCaptured = (turn: HookTurn) => new Set((turn.earlier ?? []).flatMap((e) => (e.timestamp ? [e.timestamp] : [])));
const prep = (turn: HookTurn, turnIndex: number, anchor: string | undefined, captured: ReadonlySet<string> = allCaptured(turn)) =>
  prepareTurnMessages(turn, turnIndex, anchor, captured);
const build = (turn: HookTurn, turnIndex: number, anchor: string | undefined, digest = 'd') =>
  buildTurnEnvelope('claude', turn, turnIndex, digest, prep(turn, turnIndex, anchor));

describe('buildTurnEnvelope', () => {
  const turn: HookTurn = { sessionId: 'a/b c', userText: `use ${SECRET}`, assistantText: `ok ${SECRET}`, model: 'm', cwd: '/w' };

  it('redacts secrets, encodes the session in the url and ties the id to the digest', () => {
    const env = build(turn, 3, undefined, 'deadbeefcafe');
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env.url).toBe('coolhand-hook://claude/session/a%2Fb%20c/turn/3');
    expect(env.response_body.id).toBe('a/b c:3:deadbeef');
    expect(env.request_body.messages).toEqual([{ role: 'user', content: expect.stringContaining('[REDACTED]') }]);
    expect(env.projectPath).toBe('/w');
  });

  it('omits the user message when there is none', () => {
    expect(build({ ...turn, userText: undefined }, 1, undefined).request_body.messages).toEqual([]);
  });

  it('cuts each half to the size cap and says so', () => {
    const big = 'y'.repeat(MAX_TURN_TEXT_CHARS + 500);
    const env = build({ ...turn, userText: big, assistantText: big }, 1, undefined);

    const user = (env.request_body.messages[0] as { content: string }).content;
    const assistant = (env.response_body.content as Array<{ text: string }>)[0].text;
    for (const text of [user, assistant]) {
      expect(text.length).toBeLessThan(MAX_TURN_TEXT_CHARS + 50);
      expect(text.endsWith('…[truncated]')).toBe(true);
    }
  });

  describe('the conversation so far', () => {
    const base = { sessionId: 's', model: 'm' };
    /** Exchange `n`, written `n` seconds into the session. */
    const ex = (n: number) => ({ timestamp: at(n), userText: `question ${n}`, assistantText: `answer ${n}` });

    it("turn 1 is just the user's message", () => {
      const env = build({ ...base, userText: 'question 1', assistantText: 'answer 1', earlier: [], exchangeTimestamp: at(1) }, 1, at(1));
      expect(env.request_body.messages).toEqual([{ role: 'user', content: 'question 1' }]);
    });

    it("turn 2 carries turn 1's user and assistant text and ends on turn 2's user message; response_body is turn 2's reply", () => {
      const env = build({ ...base, userText: 'question 2', assistantText: 'answer 2', earlier: [ex(1)], exchangeTimestamp: at(2) }, 2, at(1));

      expect(env.request_body.messages).toEqual([
        { role: 'user', content: 'question 1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'question 2' },
      ]);
      expect(env.response_body.content).toEqual([{ type: 'text', text: 'answer 2' }]);
      expect(env.url).toBe('coolhand-hook://claude/session/s/turn/2');
    });

    it('never sends anything from before the skill was invoked, whatever the transcript holds', () => {
      const beforeSkill = { timestamp: at(0), userText: 'private chat before the skill', assistantText: 'private reply' };
      const prepared = prep(
        { ...base, userText: 'question 3', assistantText: 'a', earlier: [beforeSkill, ex(1), ex(2)], exchangeTimestamp: at(3) },
        3,
        at(1)
      );

      expect(prepared.messages.map((m) => m.content)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3']);
      expect(JSON.stringify(prepared)).not.toContain('private');
      expect(prepared.truncated).toBe(false);
    });

    it('sends only exchanges a hook captured: commands and interrupted prompts are dropped quietly', () => {
      const earlier = [
        { timestamp: at(0), userText: 'private before the skill', assistantText: 'private reply' },
        ex(1),
        { timestamp: at(2), userText: '/compact' },
        ex(3),
        { timestamp: at(4), userText: 'an interrupted question' },
      ];
      const captured = new Set([at(1), at(3)]); // the two turns a hook saw
      const prepared = prep({ ...base, userText: 'question 5', assistantText: 'a', earlier, exchangeTimestamp: at(5) }, 3, at(1), captured);

      expect(prepared.messages.map((m) => m.content)).toEqual(['question 1', 'answer 1', 'question 3', 'answer 3', 'question 5']);
      expect(JSON.stringify(prepared)).not.toContain('private');
      expect(prepared.truncated).toBe(false); // nothing answered was missed
    });

    it('never sweeps up an answered exchange no hook captured (capture was off), and flags the gap', () => {
      const typedWhileOff = { timestamp: at(2), userText: 'typed while capture was off', assistantText: 'a private answer' };
      const prepared = prep(
        { ...base, userText: 'question 3', assistantText: 'a', earlier: [ex(1), typedWhileOff], exchangeTimestamp: at(3) },
        2,
        at(1),
        new Set([at(1)])
      );

      expect(prepared.messages.map((m) => m.content)).toEqual(['question 1', 'answer 1', 'question 3']);
      expect(JSON.stringify(prepared)).not.toMatch(/while capture was off|private answer/);
      expect(prepared.truncated).toBe(true);
    });

    it('sends no history at all, and says so, when the session has no usable anchor', () => {
      const prepared = prep({ ...base, userText: 'question 3', assistantText: 'a', earlier: [ex(1), ex(2)] }, 3, undefined);
      expect(prepared.messages).toEqual([{ role: 'user', content: 'question 3' }]);
      expect(prepared.truncated).toBe(true);
    });

    it('redacts and caps earlier messages exactly like the current turn', () => {
      const big = 'z'.repeat(MAX_TURN_TEXT_CHARS + 10);
      const { messages } = prep(
        { ...base, userText: 'q2', assistantText: 'a2', earlier: [{ timestamp: at(1), userText: `use ${SECRET}`, assistantText: big }], exchangeTimestamp: at(2) },
        2,
        at(1)
      );
      expect(JSON.stringify(messages)).not.toContain(SECRET);
      expect(messages[0].content).toContain('[REDACTED]');
      expect(String(messages[1].content).endsWith('…[truncated]')).toBe(true);
    });

    it('keeps the most recent exchanges and drops the oldest whole ones when over budget', () => {
      const chunk = 'x'.repeat(Math.floor(HISTORY_BUDGET_CHARS / 3));
      const earlier = [1, 2, 3, 4].map((n) => ({ timestamp: at(n), userText: `${n}:${chunk}`, assistantText: `${n}:${chunk}` }));
      const prepared = prep({ ...base, userText: 'now', assistantText: 'a', earlier, exchangeTimestamp: at(5) }, 5, at(1));

      const starts = prepared.messages.map((m) => m.content.slice(0, 2));
      expect(starts[starts.length - 1]).toBe('no'); // still ends on the current user message
      expect(starts).toContain('4:');
      expect(starts).not.toContain('1:');
      expect(prepared.omitted).toBeGreaterThan(0);
      expect(prepared.omitted % 2).toBe(0); // whole exchanges, so roles stay in step
      expect(prepared.truncated).toBe(true);
      const kept = prepared.messages.slice(0, -1).reduce((n, m) => n + m.content.length, 0);
      expect(kept).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
    });

    it('always keeps the newest earlier exchange, even when it alone fills the budget', () => {
      const max = 'm'.repeat(MAX_TURN_TEXT_CHARS);
      const earlier = [ex(1), { timestamp: at(2), userText: max, assistantText: max }];
      const prepared = prep({ ...base, userText: 'q', assistantText: 'a', earlier, exchangeTimestamp: at(3) }, 3, at(1));

      expect(prepared.messages.map((m) => m.content.slice(0, 1))).toEqual(['m', 'm', 'q']);
      expect(prepared.omitted).toBe(2);
    });

    it("is flagged truncated when the start of the skill's conversation has left the transcript window", () => {
      // The anchor (second 1) is older than anything the window shows; everything shown is after it.
      const prepared = prep({ ...base, userText: 'q4', assistantText: 'a', earlier: [ex(3)], exchangeTimestamp: at(4) }, 4, at(1));
      expect(prepared.messages.map((m) => m.content)).toEqual(['question 3', 'answer 3', 'q4']);
      expect(prepared.omitted).toBe(0);
      expect(prepared.truncated).toBe(true);
    });

    it('includes an exchange written exactly at the anchor, and leaves out one a moment before it', () => {
      const earlier = [{ timestamp: '2026-10-28T10:00:00.999Z', userText: 'just before', assistantText: 'x' }, ex(1)];
      const prepared = prep({ ...base, userText: 'q2', assistantText: 'a', earlier, exchangeTimestamp: at(2) }, 2, at(1));
      expect(prepared.messages.map((m) => m.content)).toEqual(['question 1', 'answer 1', 'q2']);
    });

    it('leaves out an exchange with no usable timestamp, and says so when it sits inside the conversation', () => {
      const undated = { userText: 'cannot be placed', assistantText: 'x' };
      const inside = prep({ ...base, userText: 'q3', assistantText: 'a', earlier: [ex(1), undated, ex(2)], exchangeTimestamp: at(3) }, 3, at(1));
      expect(inside.messages.map((m) => m.content)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2', 'q3']);
      expect(inside.truncated).toBe(true);

      // One before the skill began is just old history, not a gap.
      const before = prep({ ...base, userText: 'q2', assistantText: 'a', earlier: [undated, ex(1)], exchangeTimestamp: at(2) }, 2, at(1));
      expect(before.truncated).toBe(false);
    });

    it("flags an image-only prompt's exchange as missing from the history (its reply can't be paired with a user message), but not as a lost anchor", () => {
      // The skill was invoked with an image-only prompt: captured, in view, but with nothing to render.
      const prepared = prep(
        { ...base, userText: 'q2', assistantText: 'a', earlier: [], earlierStamps: [at(1)], exchangeTimestamp: at(2) },
        2,
        at(1),
        new Set([at(1)])
      );
      expect(prepared.messages).toEqual([{ role: 'user', content: 'q2' }]);
      expect(prepared.truncated).toBe(true); // flagged because of the unrenderable exchange…

      // …and a textless exchange nobody captured is just something that happened, not a gap in the log.
      const uncaptured = prep(
        { ...base, userText: 'q2', assistantText: 'a', earlier: [ex(1)], earlierStamps: [at(0), at(1)], exchangeTimestamp: at(2) },
        2,
        at(1)
      );
      expect(uncaptured.truncated).toBe(false);
    });

    describe('thinking, tool calls and tool results', () => {
      const loop = (n: number) => [
        { role: 'assistant' as const, key: `r${n}a`, blocks: [{ type: 'thinking', thinking: `thought ${n}`, signature: 'sig' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user' as const, blocks: [{ type: 'tool_result', tool_use_id: `tu${n}`, content: `output ${n}` }] },
        { role: 'assistant' as const, key: `r${n}b`, blocks: [{ type: 'text', text: `answer ${n}` }] },
      ];
      const exchange = (n: number) => ({ timestamp: at(n), userText: `question ${n}`, assistantText: `answer ${n}`, messages: loop(n) });

      it("carries earlier turns' whole tool loops as structured blocks, in order", () => {
        const prepared = prep({ ...base, userText: 'q2', assistantText: 'a', earlier: [exchange(1)], exchangeTimestamp: at(2) }, 2, at(1));

        expect(prepared.messages).toEqual([
          { role: 'user', content: 'question 1' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought 1' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'output 1' }] },
          { role: 'assistant', content: 'answer 1' },
          { role: 'user', content: 'q2' },
        ]);
        expect(JSON.stringify(prepared.messages)).not.toContain('sig'); // the opaque thinking signature is dropped
      });

      it("puts this turn's own tool loop in the request, ending on the last tool result, and its final reply (thinking + text) in response_body", () => {
        const [call, result, reply] = loop(2);
        const turn: HookTurn = { ...base, userText: 'list them', assistantText: 'answer 2', currentMessages: [call, result], finalReply: [{ type: 'thinking', thinking: 'summing up', signature: 's' }, ...reply.blocks], exchangeTimestamp: at(1) };
        const env = build(turn, 1, at(1));

        expect(env.request_body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(env.request_body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'output 2' }] });
        expect(env.response_body.content).toEqual([{ type: 'thinking', thinking: 'summing up' }, { type: 'text', text: 'answer 2' }]);
      });

      it('falls back to the text the hook was given when the transcript has no final reply to show', () => {
        const env = build({ ...base, userText: 'q', assistantText: 'the reply', exchangeTimestamp: at(1) }, 1, at(1));
        expect(env.response_body.content).toEqual([{ type: 'text', text: 'the reply' }]);
      });

      it('redacts secrets in earlier tool calls and results', () => {
        const secretLoop = [
          { role: 'assistant' as const, blocks: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: `export KEY=${SECRET}` } }] },
          { role: 'user' as const, blocks: [{ type: 'tool_result', tool_use_id: 'x', content: `KEY=${SECRET}` }] },
        ];
        const prepared = prep({ ...base, userText: 'q2', assistantText: 'a', earlier: [{ timestamp: at(1), userText: 'q1', messages: secretLoop }], exchangeTimestamp: at(2) }, 2, at(1));
        expect(JSON.stringify(prepared.messages)).not.toContain(SECRET);
      });

      it('keeps a long tool result to its cap, so one big result cannot crowd the history out', () => {
        const huge = [{ role: 'user' as const, blocks: [{ type: 'tool_result', tool_use_id: 'x', content: 'lorem ipsum '.repeat(60_000) }] }];
        const prepared = prep({ ...base, userText: 'q3', assistantText: 'a', earlier: [{ ...exchange(1), messages: huge }, exchange(2)], exchangeTimestamp: at(3) }, 3, at(1));

        expect(prepared.omitted).toBe(0); // both exchanges still fit
        expect(JSON.stringify(prepared.messages).length).toBeLessThan(20_000);
      });

      it('counts every dropped message, tool loop included, when the oldest exchanges go for size', () => {
        const chunk = 'word '.repeat(HISTORY_BUDGET_CHARS / 5);
        const big = (n: number) => ({ timestamp: at(n), userText: chunk.slice(0, 90_000), messages: [{ role: 'assistant' as const, blocks: [{ type: 'text', text: chunk.slice(0, 90_000) }] }, ...loop(n)] });
        const prepared = prep({ ...base, userText: 'now', assistantText: 'a', earlier: [big(1), big(2)], exchangeTimestamp: at(3) }, 3, at(1));

        // Exchange 1 goes whole: its prompt, the 90k reply, and the three messages of its tool loop.
        expect(prepared.omitted).toBe(5);
        expect(prepared.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('question 1'))).toBe(false);
        expect(prepared.truncated).toBe(true);
      });
    });

    describe('cumulative usage', () => {
      const tokens = (n: number) => ({ input_tokens: n, output_tokens: n * 2, cache_read_input_tokens: n * 10, cache_creation_input_tokens: n * 3 });
      const withUsage = (n: number) => ({ ...ex(n), usage: tokens(1) });

      it('is the sum across the same exchanges as the history, plus this turn', () => {
        const prepared = prep({ ...base, userText: 'q3', assistantText: 'a', usage: tokens(1), earlier: [withUsage(1), withUsage(2)], exchangeTimestamp: at(3) }, 3, at(1));
        expect(prepared.usage).toEqual(tokens(3));
      });

      it('does not count exchanges the history leaves out (uncaptured, or from before the skill)', () => {
        const before = { timestamp: at(0), userText: 'private', assistantText: 'x', usage: tokens(5) };
        const uncaptured = { ...withUsage(2) };
        const prepared = prep(
          { ...base, userText: 'q3', assistantText: 'a', usage: tokens(1), earlier: [before, withUsage(1), uncaptured], exchangeTimestamp: at(3) },
          3,
          at(1),
          new Set([at(1)])
        );
        expect(prepared.usage).toEqual(tokens(2)); // exchange 1 and this turn only
      });

      it('still counts exchanges whose messages were dropped for size (the tokens were spent)', () => {
        const chunk = 'x'.repeat(HISTORY_BUDGET_CHARS);
        const earlier = [1, 2].map((n) => ({ timestamp: at(n), userText: chunk, assistantText: chunk, usage: tokens(1) }));
        const prepared = prep({ ...base, userText: 'q', assistantText: 'a', usage: tokens(1), earlier, exchangeTimestamp: at(3) }, 3, at(1));
        expect(prepared.omitted).toBeGreaterThan(0);
        expect(prepared.usage).toEqual(tokens(3));
      });

      it('is idempotent: the same turn prepared twice reports the same total, never a running sum', () => {
        const turn = { ...base, userText: 'q2', assistantText: 'a', usage: tokens(1), earlier: [withUsage(1)], exchangeTimestamp: at(2) };
        expect(prep(turn, 2, at(1)).usage).toEqual(prep(turn, 2, at(1)).usage);
      });

      it('is absent when the transcript shows no tokens, and goes in response_body.usage when it shows some', () => {
        expect(prep({ ...base, userText: 'q', assistantText: 'a', exchangeTimestamp: at(1) }, 1, at(1)).usage).toBeUndefined();
        const turn = { ...base, userText: 'q', assistantText: 'a', usage: tokens(2), exchangeTimestamp: at(1) };
        expect(build(turn, 1, at(1)).response_body.usage).toEqual(tokens(2));
      });

      it('reports subagent totals separately, per model', () => {
        const run = (n: number) => ({ calls: 1, total: tokens(n), by_model: { 'sonnet-x': tokens(n) } });
        const prepared = prep({ ...base, userText: 'q2', assistantText: 'a', subagents: run(1), earlier: [{ ...ex(1), subagents: run(2) }], exchangeTimestamp: at(2) }, 2, at(1));
        expect(prepared.subagents).toEqual({ calls: 2, total: tokens(3), by_model: { 'sonnet-x': tokens(3) } });
        expect(prepared.usage).toBeUndefined(); // main-thread usage is not inflated by subagents
      });
    });

    describe('the skill text', () => {
      const turn: HookTurn = { sessionId: 's', userText: 'q', assistantText: 'a', exchangeTimestamp: at(1) };

      it('goes in request_body.system, redacted and capped', () => {
        const big = `# Skill\nkey=${SECRET}\n${'z'.repeat(MAX_TURN_TEXT_CHARS)}`;
        const system = buildTurnEnvelope('claude', turn, 1, 'd', prep(turn, 1, at(1)), big).request_body.system!;
        expect(system).not.toContain(SECRET);
        expect(system).toContain('[REDACTED]');
        expect(system.endsWith('…[truncated]')).toBe(true);
      });

      it('is left out when there is none', () => {
        expect('system' in buildTurnEnvelope('claude', turn, 1, 'd', prep(turn, 1, at(1))).request_body).toBe(false);
      });
    });

    it('omits the assistant message of an exchange that has no reply', () => {
      const prepared = prep(
        { ...base, assistantText: 'a', earlier: [{ timestamp: at(1), userText: 'asked, never answered' }], exchangeTimestamp: at(2) },
        2,
        at(1)
      );
      expect(prepared.messages).toEqual([{ role: 'user', content: 'asked, never answered' }]);
    });
  });
});

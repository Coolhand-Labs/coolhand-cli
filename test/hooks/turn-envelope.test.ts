import { buildTurnEnvelope, HISTORY_BUDGET_CHARS, MAX_TURN_TEXT_CHARS, prepareTurnMessages } from '../../src/sessions/turn-envelope.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

describe('buildTurnEnvelope', () => {
  const turn = { sessionId: 'a/b c', userText: `use ${SECRET}`, assistantText: `ok ${SECRET}`, model: 'm', cwd: '/w' };

  it('redacts secrets, encodes the session in the url and ties the id to the digest', () => {
    const env = buildTurnEnvelope('claude', turn, 3, 'deadbeefcafe');
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env.url).toBe('coolhand-hook://claude/session/a%2Fb%20c/turn/3');
    expect(env.response_body.id).toBe('a/b c:3:deadbeef');
    expect(env.request_body.messages).toEqual([{ role: 'user', content: expect.stringContaining('[REDACTED]') }]);
    expect(env.projectPath).toBe('/w');
  });

  it('omits the user message when there is none', () => {
    const env = buildTurnEnvelope('claude', { ...turn, userText: undefined }, 1, 'x');
    expect(env.request_body.messages).toEqual([]);
  });

  it('cuts each half to the size cap and says so', () => {
    const big = 'y'.repeat(MAX_TURN_TEXT_CHARS + 500);
    const env = buildTurnEnvelope('claude', { ...turn, userText: big, assistantText: big }, 1, 'x');

    const user = (env.request_body.messages[0] as { content: string }).content;
    const assistant = (env.response_body.content as Array<{ text: string }>)[0].text;
    for (const text of [user, assistant]) {
      expect(text.length).toBeLessThan(MAX_TURN_TEXT_CHARS + 50);
      expect(text.endsWith('…[truncated]')).toBe(true);
    }
  });

  describe('the conversation so far', () => {
    const base = { sessionId: 's', model: 'm' };
    const ex = (n: number) => ({ userText: `question ${n}`, assistantText: `answer ${n}` });

    it("turn 1 is just the user's message", () => {
      const env = buildTurnEnvelope('claude', { ...base, userText: 'question 1', assistantText: 'answer 1', earlier: [] }, 1, 'd');
      expect(env.request_body.messages).toEqual([{ role: 'user', content: 'question 1' }]);
    });

    it("turn 2 carries turn 1's user and assistant text and ends on turn 2's user message; response_body is turn 2's reply", () => {
      const env = buildTurnEnvelope(
        'claude',
        { ...base, userText: 'question 2', assistantText: 'answer 2', earlier: [ex(1)] },
        2,
        'd'
      );
      expect(env.request_body.messages).toEqual([
        { role: 'user', content: 'question 1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'question 2' },
      ]);
      expect(env.response_body.content).toEqual([{ type: 'text', text: 'answer 2' }]);
      expect(env.url).toBe('coolhand-hook://claude/session/s/turn/2');
    });

    it('never sends anything from before the skill was invoked: turn N has N-1 earlier exchanges', () => {
      const beforeSkill = { userText: 'private chat before the skill', assistantText: 'private reply' };
      const prepared = prepareTurnMessages({ ...base, userText: 'question 3', assistantText: 'a', earlier: [beforeSkill, ex(1), ex(2)] }, 3);

      expect(prepared.messages.map((m) => m.content)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3']);
      expect(JSON.stringify(prepared)).not.toContain('private');
      expect(prepared.truncated).toBe(false);
    });

    it('redacts and caps earlier messages exactly like the current turn', () => {
      const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
      const big = 'z'.repeat(MAX_TURN_TEXT_CHARS + 10);
      const { messages } = prepareTurnMessages(
        { ...base, userText: 'q2', assistantText: 'a2', earlier: [{ userText: `use ${secret}`, assistantText: big }] },
        2
      );
      expect(JSON.stringify(messages)).not.toContain(secret);
      expect(messages[0].content).toContain('[REDACTED]');
      expect(messages[1].content.endsWith('…[truncated]')).toBe(true);
    });

    it('keeps the most recent exchanges and drops the oldest whole ones when over budget', () => {
      const chunk = 'x'.repeat(Math.floor(HISTORY_BUDGET_CHARS / 3));
      const earlier = [1, 2, 3, 4].map((n) => ({ userText: `${n}:${chunk}`, assistantText: `${n}:${chunk}` }));
      const prepared = prepareTurnMessages({ ...base, userText: 'now', assistantText: 'a', earlier }, 5);

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

    it('is flagged truncated when the transcript no longer shows all the earlier exchanges', () => {
      const prepared = prepareTurnMessages({ ...base, userText: 'q4', assistantText: 'a', earlier: [ex(3)] }, 4);
      expect(prepared.messages.map((m) => m.content)).toEqual(['question 3', 'answer 3', 'q4']);
      expect(prepared.omitted).toBe(0);
      expect(prepared.truncated).toBe(true);
    });

    it('omits the assistant message of an exchange that has no reply, and the user message when it is unknown', () => {
      const prepared = prepareTurnMessages(
        { ...base, assistantText: 'a', earlier: [{ userText: 'asked, never answered' }] },
        2
      );
      expect(prepared.messages).toEqual([{ role: 'user', content: 'asked, never answered' }]);
    });
  });
});

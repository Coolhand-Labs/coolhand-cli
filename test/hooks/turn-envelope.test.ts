import { buildTurnEnvelope, MAX_TURN_TEXT_CHARS } from '../../src/sessions/turn-envelope.js';

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
});

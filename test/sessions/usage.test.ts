import { addSubagent, emptySubagentUsage, mergeSubagents } from '../../src/sessions/usage.js';

describe('subagent usage by model', () => {
  const run = { input_tokens: 5, output_tokens: 7 };

  it('keeps a model name that names an object prototype off Object.prototype', () => {
    const usage = emptySubagentUsage();
    addSubagent(usage, '__proto__', run);
    addSubagent(usage, 'constructor', run);

    expect(({} as Record<string, unknown>).input_tokens).toBeUndefined();
    expect(Object.keys(usage.by_model)).toEqual(['unknown']);
    expect(usage.by_model.unknown.input_tokens).toBe(10);
  });

  it('merges safely and bounds the length of a model name', () => {
    const into = emptySubagentUsage();
    const from = emptySubagentUsage();
    addSubagent(from, 'm'.repeat(500), run);
    mergeSubagents(into, from);

    const [key] = Object.keys(into.by_model);
    expect(key).toHaveLength(100);
    expect(into.calls).toBe(1);
  });
});

describe('subagent usage keys that name inherited properties', () => {
  it('does not write onto Object.prototype members for toString or valueOf', () => {
    const usage = emptySubagentUsage();
    addSubagent(usage, 'toString', { input_tokens: 5 });
    addSubagent(usage, 'valueOf', { input_tokens: 5 });

    expect((Object.prototype.toString as unknown as Record<string, unknown>).input_tokens).toBeUndefined();
    expect(Object.keys(usage.by_model).sort()).toEqual(['toString', 'valueOf']);
    expect(Object.values(usage.by_model).map((u) => u.input_tokens)).toEqual([5, 5]);
  });
});

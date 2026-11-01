/** Token counts in the shape Claude Code writes on every assistant message (and the ingest API reads). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** What subagents (Agent tool calls) spent, which a single log can't price: they run on other models. */
export interface SubagentUsage {
  calls: number;
  total: Usage;
  by_model: Record<string, Usage>;
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

export function emptySubagentUsage(): SubagentUsage {
  return { calls: 0, total: emptyUsage(), by_model: {} };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Add the four token fields of a raw `usage` object (anything else in it is ignored) into `into`. */
export function addUsage(into: Usage, raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    return;
  }
  const u = raw as Record<string, unknown>;
  into.input_tokens += count(u.input_tokens);
  into.output_tokens += count(u.output_tokens);
  into.cache_read_input_tokens += count(u.cache_read_input_tokens);
  into.cache_creation_input_tokens += count(u.cache_creation_input_tokens);
}

export function totalTokens(u: Usage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

/** Add one subagent run (an Agent tool result) under the model it ran on. */
export function addSubagent(into: SubagentUsage, model: string, raw: unknown): void {
  const run = emptyUsage();
  addUsage(run, raw);
  into.calls += 1;
  addUsage(into.total, run);
  addUsage((into.by_model[model] ??= emptyUsage()), run);
}

/** Fold `from` into `into`. */
export function mergeSubagents(into: SubagentUsage, from: SubagentUsage | undefined): void {
  if (!from) {
    return;
  }
  into.calls += from.calls;
  addUsage(into.total, from.total);
  for (const [model, u] of Object.entries(from.by_model)) {
    addUsage((into.by_model[model] ??= emptyUsage()), u);
  }
}

import type { RawMessage } from './blocks.js';
import type { Exchange } from './claude-scanner.js';
import type { Usage } from './usage.js';

/** An exchange from a Copilot `events.jsonl`, plus the skills invoked for it, if any. */
export interface CopilotExchange extends Exchange {
  /** Every skill invoked for this exchange: the one typed before the prompt and any the model loaded during the turn. */
  skills?: Array<{ name: string; dir: string; text: string }>;
}

export interface ParsedCopilotExchanges {
  exchanges: CopilotExchange[];
  /** The model of the latest assistant message. */
  model?: string;
}

/** Event types `parseCopilotExchanges` reads; the rest (model snapshots, permissions, hooks) are skipped before parsing. */
const WANTED = new Set(['skill.invoked', 'user.message', 'assistant.message', 'tool.execution_complete', 'session.usage_record']);
const TYPE_PREFIX = /^\{"type":"([^"]*)"/;
/** A line whose type can't be read is parsed anyway, unless it is this big. */
const MAX_UNTYPED_LINE_CHARS = 1_000_000;

/** Whether a transcript line is one `parseCopilotExchanges` needs. Cheap: reads only the line's type, without parsing it. */
export function isWantedLine(line: string): boolean {
  const type = TYPE_PREFIX.exec(line)?.[1];
  return type === undefined ? line.length <= MAX_UNTYPED_LINE_CHARS : WANTED.has(type);
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Copilot counts cached tokens inside `inputTokens`; the ingest API wants them apart, as Claude Code writes them.
 */
function usageFrom(raw: unknown): Usage | undefined {
  const u = obj(raw);
  if (!u) {
    return undefined;
  }
  const cacheRead = num(u.cacheReadTokens);
  const cacheWrite = num(u.cacheWriteTokens);
  return {
    input_tokens: Math.max(num(u.inputTokens) - cacheRead - cacheWrite, 0),
    output_tokens: num(u.outputTokens),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

/** What a tool returned. A failed call has not been seen in a recording, so its error text is looked for where it plausibly is. */
function resultText(result: unknown): string {
  const r = obj(result);
  const candidates = [r?.content, r?.detailedContent, obj(r?.error)?.message];
  const content = candidates.find((c) => typeof c === 'string' && c.trim()) ?? r?.content ?? r?.error;
  if (typeof content === 'string') {
    return content;
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/**
 * Walk a Copilot `events.jsonl` (VS Code agent mode) and return its user→assistant exchanges in order.
 * An exchange starts at a `user.message` and holds what followed as raw messages: each model call's
 * thinking, text and tool calls as one assistant message, and each batch of tool results as one user
 * message. A `skill.invoked` event the user typed (`trigger: user-invoked`) is attached to the exchange of the
 * prompt that comes next; one the model loaded during a turn is attached to the exchange already open. Unreadable
 * lines are skipped. Pure function, never throws.
 */
export function parseCopilotExchanges(content: string): ParsedCopilotExchanges {
  const exchanges: CopilotExchange[] = [];
  let model: string | undefined;
  let current: CopilotExchange | undefined;
  let pendingSkills: NonNullable<CopilotExchange['skills']> = [];

  const add = (exchange: CopilotExchange, message: RawMessage): void => {
    (exchange.messages ??= []).push(message);
  };

  for (const line of content.split('\n')) {
    if (!line.trim() || !isWantedLine(line)) {
      continue;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const data = obj(event?.data);
    if (!event || !data) {
      continue;
    }
    const timestamp = text(event.timestamp);

    switch (event.type) {
      case 'skill.invoked': {
        const file = text(data.path);
        const name = text(data.name);
        if (name) {
          const skill = { name, dir: file ? file.replace(/[\\/][^\\/]*$/, '') : name, text: text(data.content) ?? '' };
          // A skill the user typed (`/skill`) is logged just BEFORE its prompt. One the model loads itself is
          // logged during the turn it belongs to, so it goes to the exchange already open.
          if (current && text(data.trigger) !== undefined && data.trigger !== 'user-invoked') {
            (current.skills ??= []).push(skill);
          } else {
            pendingSkills.push(skill);
          }
        }
        break;
      }
      case 'user.message': {
        current = { userText: text(data.content), timestamp };
        if (pendingSkills.length > 0) {
          current.skills = pendingSkills;
          pendingSkills = [];
        }
        exchanges.push(current);
        break;
      }
      case 'assistant.message': {
        if (!current) {
          break;
        }
        const blocks: unknown[] = [];
        const reasoning = text(data.reasoningText);
        if (reasoning) {
          blocks.push({ type: 'thinking', thinking: reasoning });
        }
        const reply = text(data.content);
        if (reply) {
          blocks.push({ type: 'text', text: reply });
        }
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        for (const request of requests) {
          const r = obj(request);
          if (r && text(r.name)) {
            blocks.push({ type: 'tool_use', id: text(r.toolCallId), name: r.name, input: r.arguments ?? {} });
          }
        }
        const key = text(data.messageId);
        model = text(data.model) ?? model;
        if (blocks.length > 0) {
          add(current, { role: 'assistant', key, blocks });
        }
        // The final reply is the last message that answers in text without asking for a tool.
        if (reply && requests.length === 0) {
          current.assistantText = reply;
          current.assistantKey = key;
        }
        break;
      }
      case 'tool.execution_complete': {
        if (!current) {
          break;
        }
        const block = { type: 'tool_result', tool_use_id: text(data.toolCallId), content: resultText(data.result), is_error: data.success === false };
        const last = current.messages?.[current.messages.length - 1];
        if (last && last.role === 'user') {
          last.blocks.push(block);
        } else {
          add(current, { role: 'user', blocks: [block] });
        }
        break;
      }
      case 'session.usage_record': {
        // Only the conversation's own model calls (every recorded call of the main thread says so); other
        // kinds of call, such as background helpers, are not what this turn spent.
        const kind = text(obj(data.usage)?.interactionType);
        const usage = kind === undefined || kind === 'conversation-agent' ? usageFrom(data.usage) : undefined;
        if (current && usage) {
          const total = (current.usage ??= { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
          total.input_tokens += usage.input_tokens;
          total.output_tokens += usage.output_tokens;
          total.cache_read_input_tokens += usage.cache_read_input_tokens;
          total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        }
        break;
      }
      default:
        break;
    }
  }
  return { exchanges, model };
}

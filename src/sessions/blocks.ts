import { redactSecrets } from './redact-secrets.js';

/** Per-block caps. Redaction runs before truncation, so a secret is never cut in half and left half-visible. */
export const MAX_TURN_TEXT_CHARS = 100_000;
const MAX_THINKING_CHARS = 4_000;
const MAX_TOOL_STRING_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 2_000;
/**
 * Redaction is run on at most `max + REDACT_EXTRA_CHARS` of a string (it is quadratic on unterminated PEM
 * blocks, and the rest would be cut off anyway). When a string is longer, the last `REDACT_TAIL_CHARS` of what
 * was redacted are dropped too: a secret cut by the end of the window is not matched, and must not be left
 * half-visible.
 */
const REDACT_EXTRA_CHARS = 50_000;
const REDACT_TAIL_CHARS = 8_000;
const MAX_KEY_CHARS = 200;
const MAX_INPUT_ARRAY_ITEMS = 50;
const MAX_INPUT_KEYS = 50;
const MAX_INPUT_DEPTH = 6;
const TRUNCATED = '…[truncated]';
const REDACTED = '[REDACTED]';
/** A numeric field with one of these names is a count or a limit (`max_tokens`), not a secret. */
const COUNT_KEY = /tokens|limit|count|length|size/i;
/** A command-line flag that takes a secret as its next argument (`['--password', 'hunter2']`). */
const SECRET_FLAG = /^--?(?:(?:[a-z]{1,20}-){0,3}(?:password|passwd|token|secret|api-?key|auth(?:orization)?|access-?key|private-?key)(?:-(?:key|value))?|pass|pwd)$/i;
/**
 * Names of tool-input fields whose value is a secret whatever it looks like. `redactSecrets` finds
 * `password=...` in text, but a structured input (`{"password": "hunter2"}`) has the key and the value apart.
 */
const SECRET_KEY = /api[_-]?key|secret(?!ary)|token(?!izer)|passw(?:or)?d|pwd|(?<![a-z])pass(?![a-z])|passphrase|access[_-]?key|private[_-]?key|ssh[_-]?key|auth(?!ors?(?![a-z])|ored|ority)|bearer|jwt|dsn|connection[_-]?string|credential|signing[_-]?key|encryption[_-]?key|cookie/i;

/** A message as it sits in the transcript: raw blocks, not yet redacted or capped. */
export interface RawMessage {
  role: 'user' | 'assistant';
  /** The request id of the model call (assistant messages), used to merge its content-block lines. */
  key?: string;
  blocks: unknown[];
}

/** The blocks that are sent. Text only in the sense of no binary data; thinking, tool calls and results included. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content: string; is_error?: boolean };

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Redact, then cap (`redact: false` only measures what would be kept). The marker says text was cut. */
function clean(text: string, max: number, redact = true): string {
  if (!redact) {
    const kept = text.slice(0, max).trim();
    return text.length > max ? `${kept}${TRUNCATED}` : kept;
  }
  const window = max + REDACT_EXTRA_CHARS;
  const windowed = text.length > window;
  const body = redactSecrets(windowed ? text.slice(0, window) : text).trim();
  if (!windowed && body.length <= max) {
    return body;
  }
  const keep = windowed ? Math.min(max, body.length - REDACT_TAIL_CHARS) : max;
  return `${body.slice(0, Math.max(keep, 0))}${TRUNCATED}`;
}

/** Redacted and capped to `max` characters, with a marker when cut: the one way any captured text is sanitized. */
export function cleanText(text: string, max = MAX_TURN_TEXT_CHARS): string {
  return clean(text, max);
}

/** Redact and cap the strings of a tool call's input, keeping its shape; bound arrays, keys and depth. */
export function sanitizeInput(value: unknown, depth = 0, secret = false, redact = true): unknown {
  if (typeof value === 'string') {
    return secret && redact ? REDACTED : clean(value, MAX_TOOL_STRING_CHARS, redact);
  }
  if (typeof value === 'number') {
    return secret && redact ? REDACTED : value;
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (depth >= MAX_INPUT_DEPTH) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    // The element after a secret-named flag (`['--password', 'hunter2']`) is the secret.
    return value
      .slice(0, MAX_INPUT_ARRAY_ITEMS)
      .map((item, i, items) => sanitizeInput(item, depth + 1, secret || (i > 0 && typeof items[i - 1] === 'string' && SECRET_FLAG.test(items[i - 1] as string)), redact));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // A {name, value} pair (an HTTP header, an env var) names the secret in one field and holds it in the other.
    const namesSecret = ['name', 'key', 'header', 'variable'].some((k) => typeof record[k] === 'string' && SECRET_KEY.test(record[k] as string));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record).slice(0, MAX_INPUT_KEYS)) {
      const name = clean(key, MAX_KEY_CHARS, redact);
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        continue;
      }
      out[name] = sanitizeInput(inner, depth + 1, secret || (SECRET_KEY.test(key) && !(typeof inner === 'number' && COUNT_KEY.test(key))) || (namesSecret && (key === 'value' || key === 'val')), redact);
    }
    return out;
  }
  return undefined;
}

/** A tool result's content is a string or an array of blocks: the text of it, with images as a placeholder. */
function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== 'object') {
          return '';
        }
        const type = (b as { type?: unknown }).type;
        return type === 'text' ? String((b as { text?: unknown }).text ?? '') : type === 'image' ? '[image]' : '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

/**
 * One transcript block as it is sent: redacted, capped, and stripped of anything opaque. Thinking keeps
 * its text but not its `signature` (a long blob of no use to a reader); redacted/encrypted thinking, and
 * block types we don't know, are left out.
 */
export function sanitizeBlock(block: unknown): ContentBlock | undefined {
  if (!block || typeof block !== 'object') {
    return undefined;
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'text': {
      const text = typeof b.text === 'string' ? clean(b.text, MAX_TURN_TEXT_CHARS) : '';
      return text ? { type: 'text', text } : undefined;
    }
    case 'thinking': {
      const thinking = typeof b.thinking === 'string' ? clean(b.thinking, MAX_THINKING_CHARS) : '';
      return thinking ? { type: 'thinking', thinking } : undefined;
    }
    case 'tool_use': {
      if (typeof b.name !== 'string' || !b.name) {
        return undefined;
      }
      return { type: 'tool_use', ...(typeof b.id === 'string' ? { id: b.id.slice(0, 200) } : {}), name: b.name.slice(0, 200), input: sanitizeInput(b.input) ?? {} };
    }
    case 'tool_result':
      return {
        type: 'tool_result',
        ...(typeof b.tool_use_id === 'string' ? { tool_use_id: b.tool_use_id.slice(0, 200) } : {}),
        content: clean(resultText(b.content), MAX_TOOL_RESULT_CHARS),
        ...(b.is_error === true ? { is_error: true } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * A transcript message as it is sent. An assistant message that is nothing but one text block is sent as
 * a plain string, like an ordinary chat; anything else keeps its blocks. `undefined` when nothing survives.
 */
export function sanitizeMessage(raw: RawMessage): TurnMessage | undefined {
  const blocks = raw.blocks.map(sanitizeBlock).filter((b): b is ContentBlock => b !== undefined);
  if (blocks.length === 0) {
    return undefined;
  }
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return { role: raw.role, content: blocks[0].text };
  }
  return { role: raw.role, content: blocks };
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_TOOL_STRING_CHARS;
  }
}

/** Close to the characters `sanitizeMessage` would keep, computed without redacting anything. */
export function messageSize(raw: RawMessage): number {
  let size = 0;
  for (const block of raw.blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      size += Math.min(b.text.length, MAX_TURN_TEXT_CHARS);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      size += Math.min(b.thinking.length, MAX_THINKING_CHARS);
    } else if (b.type === 'tool_use') {
      size += jsonLength(sanitizeInput(b.input ?? {}, 0, false, false)) + 50;
    } else if (b.type === 'tool_result') {
      size += Math.min(resultText(b.content).length, MAX_TOOL_RESULT_CHARS) + 50;
    }
  }
  return size;
}

/** The text of the text blocks of a raw message, joined the way the exchange parser joins them. */
export function rawMessageText(raw: RawMessage): string {
  return raw.blocks
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter((t) => t.trim().length > 0)
    .join('\n')
    .trim();
}

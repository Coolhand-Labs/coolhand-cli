import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactSecrets } from './redact-secrets.js';
import type { ContentBlock, RawMessage } from './blocks.js';
import { addSubagent, addUsage, emptySubagentUsage, emptyUsage, type SubagentUsage, type Usage } from './usage.js';
import type { SessionFileMeta } from './session-filter.js';

/** One message in the reconstructed conversation. */
export interface ConversationMessage {
  role: string;
  /** A plain string, or content blocks (thinking, tool calls and results) for hook-captured turns. */
  content: string | ContentBlock[];
}

/**
 * An Anthropic-shaped envelope for ONE whole Claude Code session (a conversation). The server's
 * `claude_code` ingestor recognises it by the synthetic `claudecode://session/<sessionId>` url,
 * stores the full back-and-forth (the server already treats a multi-message request as one "chat"
 * log), and deduplicates on the session id. `request_body.messages` is the conversation — including
 * tool calls and tool results, serialised into each message's text so nothing is lost;
 * `response_body` is the final assistant turn; `response_body.usage` is the session's summed tokens.
 */
export interface CaptureEnvelope {
  url: string;
  method: string;
  status_code: number;
  request_body: {
    model?: string;
    /** The skill's text, for hook-captured turns. */
    system?: string;
    messages: ConversationMessage[];
  };
  response_body: {
    id: string;
    type: string;
    role: string;
    model?: string;
    content: unknown;
    usage?: unknown;
  };
  /** Number of assistant turns in this session — compared against state to detect growth. */
  turnCount: number;
  /** The session's working directory, taken from the transcript's first line carrying a
   *  non-empty string `cwd`. Undefined when no line has one — never guessed. */
  projectPath?: string;
}

export interface ScanResult {
  envelopes: CaptureEnvelope[];
  sessionCount: number;
  /** Number of session files rejected by the caller's preFilter — skipped without being read. */
  filteredOut: number;
  /** False when the scan directory could not be read and the error was swallowed. The caller must
   *  not advance its mtime cutoff in this case — doing so would permanently hide pre-existing files
   *  whose mtimes predate the new cutoff, since the turn-count guard never sees them if they are
   *  never read. */
  ok: boolean;
}

/** Cap on a single serialised tool input/output. Edit/Write inputs carry whole file bodies. */
const MAX_BLOCK_CHARS = 2000;

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** JSON.stringify that yields a placeholder instead of throwing on circular structures. */
function safeStringify(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  if (typeof json !== 'string') {
    return '';
  }
  return json;
}

function truncate(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS)}…[truncated]` : text;
}

/**
 * Render one content block as plain text. `thinking`/`redacted_thinking` are dropped for now
 * (highest-sensitivity; restored once redaction is proven) and unknown types render empty. Never throws.
 */
function blockToText(block: unknown): string {
  if (!block || typeof block !== 'object') {
    return '';
  }
  const type = (block as { type?: unknown }).type;

  if (type === 'text') {
    const text = (block as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }

  if (type === 'tool_use') {
    const name = (block as { name?: unknown }).name;
    const toolName = typeof name === 'string' ? name : 'unknown';
    const input = (block as { input?: unknown }).input;
    const rendered = input === undefined ? '' : ` ${truncate(redactSecrets(safeStringify(input)))}`;
    return `[tool_use: ${toolName}]${rendered}`;
  }

  if (type === 'tool_result') {
    const isError = (block as { is_error?: unknown }).is_error === true;
    const label = isError ? '[tool_result:error]' : '[tool_result]';
    const body = toolResultToText((block as { content?: unknown }).content);
    return body ? `${label} ${body}` : label;
  }

  if (type === 'image') {
    return '[image]';
  }

  return '';
}

/** A tool_result's `content` is a string OR an array of blocks; render either to text. */
function toolResultToText(content: unknown): string {
  if (typeof content === 'string') {
    return truncate(redactSecrets(content));
  }
  if (Array.isArray(content)) {
    return truncate(redactSecrets(content.map(blockToText).filter((part) => part.length > 0).join('\n')));
  }
  return '';
}

/** A user message's `content` is a plain string OR an array of blocks (e.g. tool_result). */
function userContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(blockToText).filter((part) => part.length > 0).join('\n');
  }
  return '';
}

/** Deep-redact secret-looking strings while preserving object/array structure. */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      out[key] = redactDeep(inner);
    }
    return out;
  }
  return value;
}

/**
 * The final assistant turn's raw blocks, prepared for `response_body.content`: thinking is dropped
 * (as in the message text) and every string is run through the secret scrubber so nothing sensitive
 * rides along in the structured half of the envelope.
 */
function sanitizeResponseBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === 'thinking' || type === 'redacted_thinking') {
      continue;
    }
    out.push(redactDeep(block));
  }
  return out;
}

interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** The stable identity of an assistant turn. One turn is split across multiple JSONL lines. */
function turnKey(event: Record<string, unknown>, message: Record<string, unknown>, sessionId: string): string {
  const requestId = event.requestId;
  if (typeof requestId === 'string' && requestId) {
    return requestId;
  }
  const messageId = message.id;
  if (typeof messageId === 'string' && messageId) {
    return messageId;
  }
  return sessionId;
}

interface PendingTurn {
  key: string;
  blocks: unknown[];
  model?: string;
}

/**
 * Parse one transcript's raw text (newline-delimited JSON) into a SINGLE session envelope holding
 * the whole conversation — one log per session, not one per turn. Returns `null` when the transcript
 * contains no assistant turns. Pure function (no filesystem) so it is easy to unit test.
 *
 * Real transcripts split a single assistant API call across MULTIPLE lines — one per content block
 * (thinking / text / tool_use) — and repeat the identical `usage` on every line. We therefore merge
 * lines that share a `requestId` into one assistant message and count each turn (and its tokens)
 * exactly once, matching benchmark/lib/transcript.mjs.
 */
export function parseTranscript(content: string, sessionId: string): CaptureEnvelope | null {
  const messages: ConversationMessage[] = [];
  const usage: SessionUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let sawUsage = false;
  let sessionModel: string | undefined;
  let lastAssistant: { id: string; content: unknown[]; model?: string } | null = null;
  let turnCount = 0;
  const countedTurns = new Set<string>();
  let pending: PendingTurn | null = null;
  let projectPath: string | undefined;

  const flushPending = (): void => {
    if (!pending) {
      return;
    }
    const text = redactSecrets(pending.blocks.map(blockToText).filter((part) => part.length > 0).join('\n')).trim();
    if (text) {
      messages.push({ role: 'assistant', content: text });
    }
    lastAssistant = { id: pending.key, content: pending.blocks, model: pending.model };
    pending = null;
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') {
      continue;
    }

    if (projectPath === undefined) {
      const cwd = event.cwd;
      if (typeof cwd === 'string' && cwd.trim().length > 0) {
        projectPath = cwd.trim();
      }
    }

    const message = event.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (event.type === 'user') {
      // A user turn ends any in-progress assistant turn (e.g. a tool_use awaiting its result).
      flushPending();
      const text = redactSecrets(userContentToText(message.content)).trim();
      if (text) {
        messages.push({ role: 'user', content: text });
      }
      continue;
    }

    if (event.type === 'assistant' && message.role === 'assistant') {
      const key = turnKey(event, message, sessionId);

      if (!pending || pending.key !== key) {
        flushPending();
        pending = { key, blocks: [], model: undefined };
      }

      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        pending.blocks.push(block);
      }

      const model = typeof message.model === 'string' ? message.model : undefined;
      if (model) {
        sessionModel = model;
        pending.model = model;
      }

      // Count each turn — and sum its usage — exactly once, no matter how many lines it spans.
      if (!countedTurns.has(key)) {
        countedTurns.add(key);
        turnCount += 1;

        const turnUsage = message.usage as Record<string, unknown> | undefined;
        if (turnUsage && typeof turnUsage === 'object') {
          sawUsage = true;
          usage.input_tokens += toCount(turnUsage.input_tokens);
          usage.output_tokens += toCount(turnUsage.output_tokens);
          usage.cache_read_input_tokens += toCount(turnUsage.cache_read_input_tokens);
          usage.cache_creation_input_tokens += toCount(turnUsage.cache_creation_input_tokens);
        }
      }
    }
  }

  flushPending();

  // A session with no assistant turns has nothing to log.
  if (!lastAssistant) {
    return null;
  }

  const finalTurn: { id: string; content: unknown[]; model?: string } = lastAssistant;

  return {
    url: `claudecode://session/${sessionId}`,
    method: 'POST',
    status_code: 200,
    request_body: {
      model: sessionModel,
      messages,
    },
    response_body: {
      id: finalTurn.id,
      type: 'message',
      role: 'assistant',
      model: finalTurn.model ?? sessionModel,
      content: sanitizeResponseBlocks(finalTurn.content),
      usage: sawUsage ? usage : undefined,
    },
    turnCount,
    projectPath,
  };
}

/** The most recent user prompt and the assistant's final reply to it, as plain text. */
export interface LastTurn {
  userText?: string;
  assistantText?: string;
  model?: string;
  /** The final assistant message's request id: unique per model call, so it tells a repeated
   *  identical turn from a hook that fired twice for one turn. */
  assistantKey?: string;
}

function isToolResultBlock(block: unknown): boolean {
  return !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result';
}

/**
 * Claude Code stores a typed slash command as markup, e.g.
 *   <command-message>loop-review</command-message>
 *   <command-name>/loop-review</command-name>
 *   <command-args>high --max-rounds 3</command-args>
 * (tags in either order, `<command-args>` present but empty when nothing was typed). The prompt the
 * user actually typed is `/loop-review high --max-rounds 3`, so that is what is recorded.
 */
function slashCommandPrompt(text: string): string {
  // Claude Code's own line starts with the markup; a prompt that merely quotes it is left alone.
  const head = text.trimStart();
  if (!head.startsWith('<command-name>') && !head.startsWith('<command-message>')) {
    return text;
  }
  const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const command = tag('command-name') ?? (tag('command-message') ? `/${tag('command-message')}` : undefined);
  if (!command) {
    return text;
  }
  const args = tag('command-args');
  return args ? `${command} ${args}` : command;
}

/** Lines Claude Code writes as user messages that the user didn't type. */
function isInterruptMarker(text: string): boolean {
  return text.startsWith('[Request interrupted by user');
}

/**
 * The OUTPUT of a local command (`/compact`, `/context`, `/status`, `/cost`, …) or of bash mode
 * (`!cmd`) is stored as a non-meta user line. It is not something the user typed and can hold account
 * details, paths and tool config, so it is never a prompt and is never uploaded.
 */
const COMMAND_OUTPUT_TAGS = ['<local-command-stdout>', '<local-command-stderr>', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];
function isCommandOutput(text: string): boolean {
  const head = text.trimStart();
  return COMMAND_OUTPUT_TAGS.some((tag) => head.startsWith(tag));
}

/**
 * Host- and harness-injected context that rides in user lines but was never typed: Conductor's
 * `<system_instruction>`, background-task `<task-notification>`s, `<system-reminder>`s and the IDE
 * extension's `<ide_opened_file>` / `<ide_selection>` blocks. They carry file paths, selected code
 * and workspace details, and a hook that re-uploads the conversation every turn would send them again
 * and again. Removed before anything is recorded.
 */
const INJECTED_TAGS = '(?:system_instruction|system-reminder|task-notification|local-command-caveat|user-prompt-submit-hook|ide_[a-z_]+)';

/**
 * Remove `<tag>…</tag>` elements of the injected kinds above. A single left-to-right pass: for each
 * opening tag it looks once, forwards, for that tag's closer; an opening tag with no closer takes the
 * rest of the text with it (fail closed). Linear in the length of the text — a regex with a lazy
 * `[\s\S]*?` per opener is quadratic on a pasted log full of unclosed tags, and this runs over up to
 * 8 MB of transcript inside a hook with a timeout. It also means a prompt that merely discusses one of
 * these tags loses the rest of that text: the cost of failing closed.
 */
function stripInjectedContext(text: string): string {
  const opener = new RegExp(`<(${INJECTED_TAGS})>`, 'g');
  let out = '';
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const match = opener.exec(text);
    if (!match) {
      out += text.slice(from);
      break;
    }
    out += text.slice(from, match.index);
    const closer = `</${match[1]}>`;
    const end = text.indexOf(closer, match.index + match[0].length);
    if (end < 0) {
      break;
    }
    from = end + closer.length;
  }
  return out.trim();
}

/** All the text of a message's content, untouched: a string, or the `text` blocks of an array. */
function rawText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

const SKILL_BODY_PREFIX = 'Base directory for this skill:';

/**
 * Claude Code injects an invoked skill as a meta user line: `Base directory for this skill: <dir>`,
 * a blank line, then the skill's text. The directory (a local path) is kept apart from the text.
 */
function parseSkillBody(text: string): { dir: string; text: string } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(SKILL_BODY_PREFIX)) {
    return undefined;
  }
  const newline = trimmed.indexOf('\n');
  const dir = (newline < 0 ? trimmed : trimmed.slice(0, newline)).slice(SKILL_BODY_PREFIX.length).trim();
  const body = newline < 0 ? '' : trimmed.slice(newline + 1).trim();
  return dir && body ? { dir, text: body } : undefined;
}

/** Plain text of a REAL user prompt: a string, or the `text` blocks of an array. Tool results are not prompts. */
function promptText(content: unknown): string {
  if (typeof content === 'string') {
    return stripInjectedContext(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
          ? stripInjectedContext(String((block as { text?: unknown }).text ?? ''))
          : ''
      )
      .filter((part) => part.length > 0)
      .join('\n');
  }
  return '';
}

/** One user prompt and the assistant's final text reply to it, as plain text. */
export interface Exchange {
  /** Undefined for a prompt with no text of its own (e.g. an image), or an assistant reply with no prompt in view. */
  userText?: string;
  /** When the user line was written (ISO 8601), straight from the transcript. */
  timestamp?: string;
  assistantText?: string;
  /** Request id of the message `assistantText` came from. */
  assistantKey?: string;
  /** Tokens the main-thread assistant messages of this exchange spent (each message counted once). */
  usage?: Usage;
  /** What subagents (Agent tool calls) made during this exchange spent, per model. */
  subagents?: SubagentUsage;
  /**
   * Everything after the user's prompt, in order, as the transcript has it: each model call's blocks
   * (thinking, text, tool calls) merged into one assistant message, and each batch of tool results as a
   * user message. Raw: redacted and capped only when sent (see `sanitizeMessage`).
   */
  messages?: RawMessage[];
  /** The skill body Claude Code injected after a slash command (`/skill`), if this exchange invoked one. */
  skill?: { dir: string; text: string };
}

export interface ParsedExchanges {
  exchanges: Exchange[];
  /** The latest real model name seen on an assistant line. */
  model?: string;
}

/**
 * Walk a transcript (or a window of one — a leading partial line is skipped like any other
 * unparseable line) and return its user→assistant exchanges in order. Only `text` content is kept:
 * no tool calls, tool results or thinking. Synthetic `isMeta` user lines (injected skill bodies,
 * caveats), compaction summaries, interrupt markers and subagent (sidechain) traffic are not prompts.
 * A typed slash command is recovered as typed. Pure function, never throws.
 */
export function parseExchanges(content: string): ParsedExchanges {
  const exchanges: Exchange[] = [];
  let model: string | undefined;
  let current: Exchange | undefined;
  let groupKey: string | undefined;
  let parts: string[] = [];
  // Claude Code repeats a message's usage on every content-block line of it: count each message, and each subagent run, once.
  const countedMessages = new Set<string>();
  const countedAgents = new Set<string>();

  const begin = (userText: string | undefined): void => {
    current = { userText };
    exchanges.push(current);
    groupKey = undefined;
    parts = [];
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = event?.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') {
      continue;
    }

    // Subagent (sidechain) traffic is not the conversation the user is having.
    if (event.isSidechain === true) {
      continue;
    }

    if (event.type === 'user') {
      // An Agent tool call's result reports what the subagent spent, and on which model.
      const result = event.toolUseResult;
      if (current && result && typeof result === 'object' && !Array.isArray(result)) {
        const run = result as Record<string, unknown>;
        const agentId = typeof run.agentId === 'string' ? run.agentId : '';
        if (agentId && run.usage && typeof run.usage === 'object' && !countedAgents.has(agentId)) {
          countedAgents.add(agentId);
          const model = typeof run.resolvedModel === 'string' && run.resolvedModel ? run.resolvedModel : 'unknown';
          addSubagent((current.subagents ??= emptySubagentUsage()), model, run.usage);
        }
      }
      // Tool results come back as user lines; they are part of the exchange's conversation.
      if (current && Array.isArray(message.content)) {
        const results = message.content.filter(isToolResultBlock);
        if (results.length > 0) {
          (current.messages ??= []).push({ role: 'user', blocks: results });
        }
      }
      // The expanded skill body, injected right after the slash command that invoked it.
      if (event.isMeta === true && current && !current.skill) {
        current.skill = parseSkillBody(rawText(message.content));
      }
      // Meta lines are injected context and compaction summaries are generated, not typed. A line
      // carrying any tool_result is the tool loop talking, whatever else rides along with it.
      if (
        event.isMeta === true ||
        event.isCompactSummary === true ||
        (Array.isArray(message.content) && message.content.some(isToolResultBlock))
      ) {
        continue;
      }
      const text = slashCommandPrompt(promptText(message.content).trim());
      if (isCommandOutput(text)) {
        continue;
      }
      // A prompt with no text of its own (e.g. an image) still starts a new turn: the reply that
      // follows must not be paired with the previous prompt.
      // (A line whose every text block was injected context and has nothing else in it is not a prompt.)
      const textlessPrompt =
        !text &&
        Array.isArray(message.content) &&
        message.content.some((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type !== 'text');
      if ((text && !isInterruptMarker(text)) || textlessPrompt) {
        // A new prompt starts a new exchange; whatever assistant text we had belonged to the old one.
        begin(text || undefined);
        if (typeof event.timestamp === 'string' && event.timestamp) {
          (current as Exchange).timestamp = event.timestamp;
        }
      }
      continue;
    }

    if (event.type === 'assistant' && message.role === 'assistant') {
      if (!current) {
        begin(undefined);
      }
      const exchange = current as Exchange;
      const key = turnKey(event, message, '');
      if (key && !countedMessages.has(key) && message.usage && typeof message.usage === 'object') {
        countedMessages.add(key);
        addUsage((exchange.usage ??= emptyUsage()), message.usage);
      }
      if (key !== groupKey) {
        groupKey = key;
        parts = [];
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      // One assistant message per model call: its content-block lines share a request id.
      const sequence = (exchange.messages ??= []);
      const lastMessage = sequence[sequence.length - 1];
      if (lastMessage && lastMessage.role === 'assistant' && lastMessage.key === key && key) {
        lastMessage.blocks.push(...blocks);
      } else {
        sequence.push({ role: 'assistant', key: key || undefined, blocks: [...blocks] });
      }
      for (const block of blocks) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string' && text.trim()) {
            parts.push(text);
          }
        }
      }
      if (parts.length > 0) {
        exchange.assistantText = parts.join('\n').trim();
        // The key of the message the text came from, not of a later tool-only message.
        exchange.assistantKey = key || undefined;
      }
      // Claude Code's own placeholder messages (interrupts, API errors) carry a pseudo-model.
      if (typeof message.model === 'string' && message.model && message.model !== '<synthetic>') {
        model = message.model;
      }
    }
  }

  return { exchanges, model };
}

/** The latest exchange of already-parsed exchanges, in the shape the Stop-hook adapter wants. */
export function lastTurnFrom(parsed: ParsedExchanges): LastTurn {
  const last = parsed.exchanges[parsed.exchanges.length - 1];
  return {
    userText: last?.userText,
    assistantText: last?.assistantText,
    model: parsed.model,
    assistantKey: last?.assistantText ? last.assistantKey : undefined,
  };
}

/**
 * Pull the latest user prompt and the final assistant message out of a transcript (or a window of
 * one). Only `text` content is returned. Pure function, never throws.
 */
export function extractLastTurn(content: string): LastTurn {
  return lastTurnFrom(parseExchanges(content));
}

/**
 * Find every Claude Code transcript under `projectsDir` (default `~/.claude/projects`) and build one
 * conversation envelope per session. A missing directory simply yields zero sessions.
 *
 * When `sinceTime` is given, files whose last-modified time is older than it are skipped entirely
 * (not even read) — they cannot have grown since the last sync. `sessionCount` therefore counts only
 * the files actually examined this run, so it reflects the work done rather than the whole corpus.
 *
 * When `preFilter` is given it runs on each file's metadata (id, project folder, mtime) BEFORE the
 * file is read; a rejected file is counted in `filteredOut` and its content never leaves disk.
 */
export async function scanSessions(
  options: {
    projectsDir?: string;
    sinceTime?: Date;
    preFilter?: (meta: SessionFileMeta) => boolean;
  } = {}
): Promise<ScanResult> {
  const dir = options.projectsDir ?? defaultProjectsDir();
  const sinceMs = options.sinceTime?.getTime();
  const preFilter = options.preFilter;

  let names: string[];
  try {
    names = await fs.readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { envelopes: [], sessionCount: 0, filteredOut: 0, ok: true };
    }
    throw err;
  }

  const files = names.filter((name) => name.endsWith('.jsonl'));
  const envelopes: CaptureEnvelope[] = [];
  let sessionCount = 0;
  let filteredOut = 0;

  for (const relativePath of files) {
    const fullPath = path.join(dir, relativePath);

    let mtimeMs = 0;
    if (sinceMs !== undefined || preFilter !== undefined) {
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        // Unreadable transcript — skip it rather than failing the whole scan.
        continue;
      }
      mtimeMs = stat.mtimeMs;
      // Skip files unchanged since the cutoff. Use `>=` so a file touched exactly at the cutoff
      // is still examined.
      if (sinceMs !== undefined && mtimeMs < sinceMs) {
        continue;
      }
    }

    if (preFilter !== undefined) {
      // readdir({recursive}) yields platform separators; split on both to find the project folder.
      const parts = relativePath.split(/[\\/]/);
      const meta: SessionFileMeta = {
        sessionId: path.basename(relativePath, '.jsonl'),
        project: parts.length > 1 ? parts[0] : null,
        mtimeMs,
        source: 'claude-code',
      };
      if (!preFilter(meta)) {
        filteredOut += 1;
        continue;
      }
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      // Unreadable transcript — skip it rather than failing the whole scan.
      continue;
    }
    sessionCount += 1;
    const sessionId = path.basename(relativePath, '.jsonl');

    let envelope: CaptureEnvelope | null;
    try {
      envelope = parseTranscript(content, sessionId);
    } catch {
      // A single malformed transcript must never abort the whole scan.
      continue;
    }
    if (envelope) {
      envelopes.push(envelope);
    }
  }

  return { envelopes, sessionCount, filteredOut, ok: true };
}

/** The session id this envelope represents — used as the local dedup key. */
export function sessionIdOf(envelope: CaptureEnvelope): string {
  const m = envelope.url.match(/^[a-z]+:\/\/session\/(.+)$/);
  return m ? m[1] : envelope.url;
}

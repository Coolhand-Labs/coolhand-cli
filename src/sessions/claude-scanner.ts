import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactSecrets } from './redact-secrets.js';
import type { SessionFileMeta } from './session-filter.js';

/** One message in the reconstructed conversation. */
export interface ConversationMessage {
  role: string;
  content: string;
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
  if (!text.includes('<command-name>') && !text.includes('<command-message>')) {
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

/** Plain text of a REAL user prompt: a string, or the `text` blocks of an array. Tool results are not prompts. */
function promptText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : ''
      )
      .filter((part) => part.length > 0)
      .join('\n');
  }
  return '';
}

/**
 * Pull the latest user prompt and the final assistant message out of a transcript (or the tail of
 * one — a leading partial line is skipped like any other unparseable line). Only `text` content is
 * returned: no tool calls, tool results or thinking. Synthetic `isMeta` user lines (injected skill
 * bodies, caveats) are not prompts. Pure function, never throws.
 */
export function extractLastTurn(content: string): LastTurn {
  let userText: string | undefined;
  let assistantText: string | undefined;
  let model: string | undefined;
  let assistantKey: string | undefined;
  let textKey: string | undefined;
  let assistantParts: string[] = [];

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
      // A prompt with no text of its own (e.g. an image) still starts a new turn: the reply that
      // follows must not be paired with the previous prompt.
      const textlessPrompt = !text && Array.isArray(message.content) && message.content.length > 0;
      if ((text && !isInterruptMarker(text)) || textlessPrompt) {
        // A new prompt starts a new turn; whatever assistant text we had belonged to the old one.
        userText = text || undefined;
        assistantText = undefined;
        assistantKey = undefined;
        textKey = undefined;
        assistantParts = [];
      }
      continue;
    }

    if (event.type === 'assistant' && message.role === 'assistant') {
      const key = turnKey(event, message, '');
      if (key !== assistantKey) {
        assistantKey = key;
        assistantParts = [];
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string' && text.trim()) {
            assistantParts.push(text);
          }
        }
      }
      if (assistantParts.length > 0) {
        assistantText = assistantParts.join('\n').trim();
        // The key of the message the returned text came from, not of a later tool-only message.
        textKey = key;
      }
      // Claude Code's own placeholder messages (interrupts, API errors) carry a pseudo-model.
      if (typeof message.model === 'string' && message.model && message.model !== '<synthetic>') {
        model = message.model;
      }
    }
  }

  return { userText, assistantText, model, assistantKey: assistantText ? textKey || undefined : undefined };
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

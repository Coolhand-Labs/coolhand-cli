import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One message in the reconstructed conversation. */
export interface ConversationMessage {
  role: string;
  content: string;
}

/**
 * An Anthropic-shaped envelope for ONE whole Claude Code session (a conversation). The server's
 * `claude_code` ingestor recognises it by the synthetic `claudecode://session/<sessionId>` url,
 * stores the full back-and-forth (the server already treats a multi-message request as one "chat"
 * log), and deduplicates on the session id. `request_body.messages` is the conversation;
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
}

export interface ScanResult {
  envelopes: CaptureEnvelope[];
  sessionCount: number;
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Pull plain text out of a Claude message `content`, which is either a string or block array. */
function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          Boolean(block) &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
      )
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Parse one transcript's raw text (newline-delimited JSON) into a SINGLE session envelope holding
 * the whole conversation — one log per session, not one per turn. Returns `null` when the transcript
 * contains no assistant turns. Pure function (no filesystem) so it is easy to unit test.
 */
export function parseTranscript(content: string, sessionId: string): CaptureEnvelope | null {
  const messages: ConversationMessage[] = [];
  const usage: SessionUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let sawUsage = false;
  let sessionModel: string | undefined;
  let lastAssistant: { id: string; content: unknown; model?: string } | null = null;
  let turnCount = 0;

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

    const message = event.message as Record<string, unknown> | undefined;
    if (!message) {
      continue;
    }

    if (event.type === 'user') {
      // `user` events include tool results (no text) — only keep actual prompt text.
      const text = extractText(message.content);
      if (text) {
        messages.push({ role: 'user', content: text });
      }
      continue;
    }

    if (event.type === 'assistant' && message.role === 'assistant') {
      const requestId =
        typeof event.requestId === 'string'
          ? event.requestId
          : typeof message.id === 'string'
            ? message.id
            : undefined;

      messages.push({ role: 'assistant', content: extractText(message.content) });
      turnCount += 1;

      const model = typeof message.model === 'string' ? message.model : undefined;
      if (model) {
        sessionModel = model;
      }

      const turnUsage = message.usage as Record<string, unknown> | undefined;
      if (turnUsage && typeof turnUsage === 'object') {
        sawUsage = true;
        usage.input_tokens += toCount(turnUsage.input_tokens);
        usage.output_tokens += toCount(turnUsage.output_tokens);
        usage.cache_read_input_tokens += toCount(turnUsage.cache_read_input_tokens);
      }

      lastAssistant = {
        id: requestId ?? sessionId,
        content: Array.isArray(message.content) ? message.content : [],
        model,
      };
    }
  }

  // A session with no assistant turns has nothing to log.
  if (!lastAssistant) {
    return null;
  }

  return {
    url: `claudecode://session/${sessionId}`,
    method: 'POST',
    status_code: 200,
    request_body: {
      model: sessionModel,
      messages,
    },
    response_body: {
      id: lastAssistant.id,
      type: 'message',
      role: 'assistant',
      model: lastAssistant.model ?? sessionModel,
      content: lastAssistant.content,
      usage: sawUsage ? usage : undefined,
    },
    turnCount,
  };
}

/**
 * Find every Claude Code transcript under `projectsDir` (default `~/.claude/projects`) and build one
 * conversation envelope per session. A missing directory simply yields zero sessions.
 *
 * When `sinceTime` is given, files whose last-modified time is older than it are skipped entirely
 * (not even read) — they cannot have grown since the last sync. `sessionCount` therefore counts only
 * the files actually examined this run, so it reflects the work done rather than the whole corpus.
 */
export async function scanSessions(
  options: { projectsDir?: string; sinceTime?: Date } = {}
): Promise<ScanResult> {
  const dir = options.projectsDir ?? defaultProjectsDir();
  const sinceMs = options.sinceTime?.getTime();

  let names: string[];
  try {
    names = await fs.readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { envelopes: [], sessionCount: 0 };
    }
    throw err;
  }

  const files = names.filter((name) => name.endsWith('.jsonl'));
  const envelopes: CaptureEnvelope[] = [];
  let sessionCount = 0;

  for (const relativePath of files) {
    const fullPath = path.join(dir, relativePath);

    if (sinceMs !== undefined) {
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        // Unreadable transcript — skip it rather than failing the whole scan.
        continue;
      }
      // Skip files unchanged since the cutoff. Use `>=` so a file touched exactly at the cutoff
      // is still examined.
      if (stat.mtimeMs < sinceMs) {
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
    const envelope = parseTranscript(content, sessionId);
    if (envelope) {
      envelopes.push(envelope);
    }
  }

  return { envelopes, sessionCount };
}

/** The session id this envelope represents — used as the local dedup key. */
export function sessionIdOf(envelope: CaptureEnvelope): string {
  return envelope.url.replace(/^claudecode:\/\/session\//, '');
}

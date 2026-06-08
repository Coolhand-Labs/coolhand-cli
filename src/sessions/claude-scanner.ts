import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * An Anthropic-shaped envelope for one Claude Code transcript turn. The server's
 * `claude_code` ingestor recognises it by the synthetic `claudecode://` url and reuses the
 * Anthropic content/usage extraction. `response_body.id` is the transcript requestId and is
 * the stable per-turn key the server deduplicates on.
 */
export interface CaptureEnvelope {
  url: string;
  method: string;
  status_code: number;
  request_body: {
    model?: string;
    messages: Array<{ role: string; content: string }>;
  };
  response_body: {
    id: string;
    type: string;
    role: string;
    model?: string;
    content: unknown;
    usage?: unknown;
  };
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

interface AssistantTurn {
  requestId: string;
  sessionId: string;
  message: Record<string, unknown>;
  userText: string;
}

function buildEnvelope(turn: AssistantTurn): CaptureEnvelope {
  const { requestId, sessionId, message, userText } = turn;
  const model = typeof message.model === 'string' ? message.model : undefined;
  return {
    url: `claudecode://session/${sessionId}/${requestId}`,
    method: 'POST',
    status_code: 200,
    request_body: {
      model,
      messages: [{ role: 'user', content: userText }],
    },
    response_body: {
      id: requestId,
      type: 'message',
      role: 'assistant',
      model,
      content: Array.isArray(message.content) ? message.content : [],
      usage: message.usage,
    },
  };
}

/**
 * Parse one transcript's raw text (newline-delimited JSON) into one envelope per assistant turn.
 * Pure function — no filesystem — so it is easy to unit test. `sessionIdFallback` is used when a
 * line does not carry its own `sessionId` (typically the transcript filename).
 */
export function parseTranscript(content: string, sessionIdFallback: string): CaptureEnvelope[] {
  const envelopes: CaptureEnvelope[] = [];
  let lastUserText = '';

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
      const text = extractText(message.content);
      if (text) {
        lastUserText = text;
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
      if (!requestId) {
        // No stable id means the server cannot deduplicate this turn — skip it.
        continue;
      }
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : sessionIdFallback;
      envelopes.push(buildEnvelope({ requestId, sessionId, message, userText: lastUserText }));
    }
  }

  return envelopes;
}

/**
 * Find every Claude Code transcript under `projectsDir` (default `~/.claude/projects`) and build
 * envelopes for all assistant turns. A missing directory simply yields zero sessions.
 */
export async function scanSessions(options: { projectsDir?: string } = {}): Promise<ScanResult> {
  const dir = options.projectsDir ?? defaultProjectsDir();

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
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, relativePath), 'utf8');
    } catch {
      // Unreadable transcript — skip it rather than failing the whole scan.
      continue;
    }
    sessionCount += 1;
    const sessionId = path.basename(relativePath, '.jsonl');
    envelopes.push(...parseTranscript(content, sessionId));
  }

  return { envelopes, sessionCount };
}

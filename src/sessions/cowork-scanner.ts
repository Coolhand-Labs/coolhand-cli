import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTranscript, type CaptureEnvelope, type ScanResult } from './claude-scanner.js';
import type { SessionFileMeta } from './session-filter.js';

export function defaultCoworkSessionsDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions'
  );
}

/**
 * Matches the `local_<uuid>/audit.jsonl` path suffix that identifies one Cowork agent invocation.
 * Captures the UUID portion (group 1) which becomes the session id.
 */
const LOCAL_AUDIT_RE = /[/\\]local_([^/\\]+)[/\\]audit\.jsonl$/;

/**
 * Scan Claude Cowork sessions stored under `~/Library/Application Support/Claude/local-agent-mode-sessions/`.
 *
 * Structure: <workspace-uuid>/<cowork-session-uuid>/local_<session-uuid>/audit.jsonl
 * Each `local_<uuid>` directory represents one agent invocation and maps to one session envelope.
 *
 * The `audit.jsonl` format is compatible with `parseTranscript` — same `user`/`assistant` event
 * shapes. Cowork-only event types (`system`, `rate_limit_event`) have no `message` field and are
 * silently skipped. Sessions use `cowork://session/<uuid>` URLs to distinguish them from Claude Code
 * sessions (`claudecode://session/<id>`).
 *
 * Returns an empty result when the directory is missing (non-macOS systems, first-time setup, etc.).
 */
export async function scanCoworkSessions(
  options: {
    sessionsDir?: string;
    sinceTime?: Date;
    preFilter?: (meta: SessionFileMeta) => boolean;
  } = {}
): Promise<ScanResult> {
  const dir = options.sessionsDir ?? defaultCoworkSessionsDir();
  const sinceMs = options.sinceTime?.getTime();
  const preFilter = options.preFilter;

  let names: string[];
  try {
    names = await fs.readdir(dir, { recursive: true });
  } catch {
    // Treat any readdir failure (ENOENT, EACCES, ENOTDIR, …) as an empty result. Cowork scanning
    // is best-effort and macOS-only; an error here must not abort the Claude Code capture running
    // in parallel inside Promise.all.
    return { envelopes: [], sessionCount: 0, filteredOut: 0, ok: false };
  }

  const files = (names as string[]).filter((name) => LOCAL_AUDIT_RE.test(name));
  const envelopes: CaptureEnvelope[] = [];
  let sessionCount = 0;
  let filteredOut = 0;

  for (const relativePath of files) {
    const fullPath = path.join(dir, relativePath);

    // The id lives in the path (already matched by LOCAL_AUDIT_RE above), so it is known
    // before the file is read — which is what lets preFilter reject without reading.
    const m = relativePath.match(LOCAL_AUDIT_RE);
    if (!m) { continue; }
    const sessionUuid = m[1];

    let mtimeMs = 0;
    if (sinceMs !== undefined || preFilter !== undefined) {
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      mtimeMs = stat.mtimeMs;
      if (sinceMs !== undefined && mtimeMs < sinceMs) {
        continue;
      }
    }

    if (preFilter !== undefined) {
      const meta: SessionFileMeta = { sessionId: sessionUuid, project: null, mtimeMs, source: 'cowork' };
      if (!preFilter(meta)) {
        filteredOut += 1;
        continue;
      }
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    sessionCount += 1;

    const envelope = parseTranscript(content, sessionUuid);
    if (envelope) {
      // parseTranscript captures `cwd` from the FIRST line that has one, regardless of event type
      // (before it even checks for a `message` field) — so it can and does pick up the system/init
      // line's `cwd` here. That value is Cowork's own internal sandbox output path, not a real user
      // project, so it must be stripped: this is the only thing preventing it from leaking into
      // projectPath, not redundant extra insurance.
      envelopes.push({ ...envelope, url: `cowork://session/${sessionUuid}`, projectPath: undefined });
    }
  }

  return { envelopes, sessionCount, filteredOut, ok: true };
}

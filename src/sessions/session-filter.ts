/**
 * Pure, pre-read session filtering. The predicate built here runs on metadata knowable
 * BEFORE a transcript is read (filename, project folder, file mtime) so excluded sessions
 * are never loaded from disk — the compliance guarantee behind --project/--until.
 */

/** What a scanner knows about a session file before reading its content. */
export interface SessionFileMeta {
  sessionId: string;
  /** Encoded project folder under ~/.claude/projects; null for Cowork sessions. */
  project: string | null;
  mtimeMs: number;
  source: 'claude-code' | 'cowork';
}

export interface FilterCriteria {
  sinceMs?: number;
  untilMs?: number;
  includeProjects?: string[];
  excludeProjects?: string[];
}

/**
 * Normalise a project name for matching: lowercase with every non-alphanumeric run
 * collapsed to a single dash, so user input ("Coolhand CLI") and the encoded folder
 * name ("C--Users-...-coolhand-cli") compare on the same footing.
 */
export function sanitizeProjectKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Build a predicate deciding whether a session file may be read and considered for upload. */
export function buildSessionFilter(criteria: FilterCriteria): (meta: SessionFileMeta) => boolean {
  const includes = (criteria.includeProjects ?? []).map(sanitizeProjectKey);
  const excludes = (criteria.excludeProjects ?? []).map(sanitizeProjectKey);

  return (meta: SessionFileMeta): boolean => {
    const projectKey = meta.project === null ? null : sanitizeProjectKey(meta.project);

    if (includes.length > 0) {
      // A session with no project (Cowork) cannot match an include list.
      if (projectKey === null || !includes.some((needle) => projectKey.includes(needle))) {
        return false;
      }
    }

    if (projectKey !== null && excludes.some((needle) => projectKey.includes(needle))) {
      return false;
    }

    if (criteria.sinceMs !== undefined && meta.mtimeMs < criteria.sinceMs) {
      return false;
    }

    if (criteria.untilMs !== undefined && meta.mtimeMs > criteria.untilMs) {
      return false;
    }

    return true;
  };
}

import { promises as fs } from 'fs';
import * as path from 'path';
import { configDir, atomicWriteFile } from '../config.js';
import { CliError } from '../errors.js';

/**
 * Local record of which skills have already been uploaded to Coolhand for each client, so
 * re-running `sync-skills` does not re-upload a skill whose content hasn't changed — but DOES
 * re-upload one whose authored content changed since last time.
 *
 * Kept as its own file (not merged into `capture-state.json`) because the tracking model differs:
 * a session transcript accumulates turns over time (tracked by a growing count), while a skill
 * file is a monolithic blob (tracked by a simple content-hash comparison). Keyed per client id,
 * since the same skill may legitimately be uploaded for more than one client.
 */
export interface SkillUploadRecord {
  contentHash: string;
  uploadedAt: string;
  clientFileId?: string;
}

export interface SkillState {
  version: number;
  uploaded: Record<string, Record<string, SkillUploadRecord>>;
}

/**
 * Composite key for the per-client `uploaded` map: `(skillName, contentHash)`, not skillName
 * alone. `dedupeSkillFiles` (skill-scanner.ts) can legitimately produce two candidates that share
 * a skillName but have different content — e.g. a just-edited authored copy alongside a stale
 * `installed` duplicate of the pre-edit content that hasn't been cleaned up yet. Keying state by
 * skillName alone would make the second recorded upload overwrite the first's record, so on every
 * later run whichever candidate's hash no longer matches the single stored one would be
 * re-uploaded and immediately overwrite the record again — an unbounded re-upload loop for
 * exactly the scenario the (skillName, contentHash) dedup grouping exists to handle correctly.
 * Keying state at the same granularity as the candidates themselves avoids that collision.
 */
function stateKey(skillName: string, contentHash: string): string {
  return JSON.stringify([skillName, contentHash]);
}

const STATE_VERSION = 1;
const STATE_FILENAME = 'skills-state.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function skillStatePath(): string {
  return path.join(configDir(), STATE_FILENAME);
}

function emptyState(): SkillState {
  return { version: STATE_VERSION, uploaded: {} };
}

function toUploadRecord(value: unknown): SkillUploadRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as Partial<SkillUploadRecord>;
  if (typeof entry.contentHash !== 'string' || typeof entry.uploadedAt !== 'string') {
    return null;
  }
  return {
    contentHash: entry.contentHash,
    uploadedAt: entry.uploadedAt,
    ...(typeof entry.clientFileId === 'string' && { clientFileId: entry.clientFileId }),
  };
}

function normalizeUploaded(raw: unknown): Record<string, Record<string, SkillUploadRecord>> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, Record<string, SkillUploadRecord>> = {};
  for (const [clientId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const skills: Record<string, SkillUploadRecord> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const record = toUploadRecord(entry);
      if (record) {
        skills[key] = record;
      }
    }
    out[clientId] = skills;
  }
  return out;
}

export async function loadSkillState(): Promise<SkillState> {
  const filePath = skillStatePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState();
    }
    throw new CliError('CONFIG_READ_FAILED', `Failed to read ${filePath}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SkillState> & { uploaded?: unknown };
    return {
      version: STATE_VERSION,
      uploaded: normalizeUploaded(parsed.uploaded),
    };
  } catch (err) {
    throw new CliError('CONFIG_READ_FAILED', `Skill state at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
}

/** The upload record for this exact (skillName, contentHash) pair and client, or undefined if
 *  this exact content has never been uploaded under this name for this client — a differently-
 *  hashed prior upload of the same skillName does not count as a match. */
export function getUploadRecord(
  state: SkillState,
  clientId: string,
  skillName: string,
  contentHash: string
): SkillUploadRecord | undefined {
  return state.uploaded[clientId]?.[stateKey(skillName, contentHash)];
}

/** Record that this exact (skillName, contentHash) pair has now been uploaded for this client. */
export function recordUpload(
  state: SkillState,
  clientId: string,
  skillName: string,
  contentHash: string,
  record: SkillUploadRecord
): void {
  const skills = state.uploaded[clientId] ?? (state.uploaded[clientId] = {});
  skills[stateKey(skillName, contentHash)] = record;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // POSIX-only — Windows rejects chmod with this mode; ignore.
  }
}

export async function saveSkillState(state: SkillState): Promise<void> {
  const filePath = skillStatePath();
  await ensureDir(path.dirname(filePath));
  await atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`, FILE_MODE);
}

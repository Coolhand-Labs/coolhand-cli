import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

/** Where a discovered SKILL.md was found, used both for display and for dedup priority
 *  (see `dedupeSkillFiles`) — an authored copy is preferred over an installed runtime copy of
 *  the same content. */
export type SkillSourceKind = 'authored' | 'installed' | 'claude-code' | 'custom';

export interface SkillRoot {
  root: string;
  sourceKind: SkillSourceKind;
}

export interface DiscoveredSkillFile {
  filePath: string;
  sourceKind: SkillSourceKind;
  root: string;
  mtimeMs: number;
  contentHash: string;
  skillName: string;
  description?: string;
}

export interface SkillCandidate {
  skillName: string;
  contentHash: string;
  /** The chosen canonical file to upload for this (skillName, contentHash) group. */
  filePath: string;
  sourceKind: SkillSourceKind;
  root: string;
  description?: string;
  /** How many other on-disk copies (this file included) share this exact (skillName, contentHash). */
  duplicateCount: number;
}

/** Priority order when picking the canonical file within a (skillName, contentHash) group —
 *  lower index wins. An authored, user-facing copy is preferred over an installed runtime copy
 *  of the identical content, since it's the more meaningful "source" location to cite. */
const SOURCE_KIND_PRIORITY: SkillSourceKind[] = ['authored', 'claude-code', 'installed', 'custom'];

/**
 * Recursively find every `SKILL.md` file under `root`. Any `fs.readdir` failure (missing
 * directory, permissions, etc.) is treated as "zero matches from this root" — not fatal — since
 * a machine commonly won't have all of `~/Documents/Claude`, the Cowork sessions directory, or
 * `~/.claude/skills` present at once.
 */
async function findSkillFilesInRoot(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(root, { recursive: true });
  } catch {
    return [];
  }
  return names.filter((name) => path.basename(name) === 'SKILL.md').map((name) => path.join(root, name));
}

/**
 * Extract `name:`/`description:` from a SKILL.md's YAML frontmatter block (`---\n...\n---` at
 * the top of the file) with a small regex extractor rather than a YAML dependency — `js-yaml`
 * is only an `overrides` pin in package.json (a transitive-dependency version pin), not a direct
 * dependency, so parsing full YAML here would require adding one for a single flat key lookup.
 * Values may be quoted or bare; quotes are stripped. Returns {} when there's no frontmatter block
 * or it has no `name:`/`description:` field.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const block = match[1];
  const nameMatch = block.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  const descriptionMatch = block.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const result: { name?: string; description?: string } = {};
  if (nameMatch) {
    result.name = nameMatch[1];
  }
  if (descriptionMatch) {
    result.description = descriptionMatch[1];
  }
  return result;
}

/**
 * Discover SKILL.md files across every root, reading and hashing each one. A file that can't be
 * read (permissions, a race with deletion, etc.) is skipped with a warning via `onWarn` rather
 * than aborting the whole scan — same convention as `map-claude-projects`' directory walk.
 */
export async function findSkillFiles(
  roots: SkillRoot[],
  onWarn?: (message: string) => void
): Promise<DiscoveredSkillFile[]> {
  const discovered: DiscoveredSkillFile[] = [];

  for (const { root, sourceKind } of roots) {
    const filePaths = await findSkillFilesInRoot(root);
    for (const filePath of filePaths) {
      let stat;
      let content: Buffer;
      try {
        stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          continue;
        }
        content = await fs.readFile(filePath);
      } catch (err) {
        onWarn?.(`Skipping unreadable skill file "${filePath}": ${(err as Error).message}`);
        continue;
      }

      const contentHash = createHash('sha256').update(content).digest('hex');
      const frontmatter = parseSkillFrontmatter(content.toString('utf8'));
      const skillName = frontmatter.name ?? path.basename(path.dirname(filePath));

      discovered.push({
        filePath,
        sourceKind,
        root,
        mtimeMs: stat.mtimeMs,
        contentHash,
        skillName,
        description: frontmatter.description,
      });
    }
  }

  return discovered;
}

/**
 * Group discovered files by `(skillName, contentHash)` — not skill name alone, so a genuinely
 * edited authored copy is never silently squashed by a stale installed duplicate of the same
 * name — and pick one canonical file per group to actually upload. Within a group, prefer
 * (in order): `sourceKind` priority (authored > claude-code > installed > custom), then newest
 * `mtimeMs`, then path ascending for a deterministic tie-break.
 */
export function dedupeSkillFiles(files: DiscoveredSkillFile[]): SkillCandidate[] {
  const groups = new Map<string, DiscoveredSkillFile[]>();
  for (const file of files) {
    const key = JSON.stringify([file.skillName, file.contentHash]);
    const group = groups.get(key);
    if (group) {
      group.push(file);
    } else {
      groups.set(key, [file]);
    }
  }

  const candidates: SkillCandidate[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const priorityDiff = SOURCE_KIND_PRIORITY.indexOf(a.sourceKind) - SOURCE_KIND_PRIORITY.indexOf(b.sourceKind);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      if (b.mtimeMs !== a.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return a.filePath.localeCompare(b.filePath);
    });
    const chosen = sorted[0];
    candidates.push({
      skillName: chosen.skillName,
      contentHash: chosen.contentHash,
      filePath: chosen.filePath,
      sourceKind: chosen.sourceKind,
      root: chosen.root,
      description: chosen.description,
      duplicateCount: group.length,
    });
  }

  return candidates;
}

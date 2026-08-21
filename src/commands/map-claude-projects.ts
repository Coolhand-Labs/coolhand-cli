import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { uploadClientFile } from '../upload-client-file.js';
import type { MapClaudeProjectsOptions } from '../types.js';

export interface MapClaudeProjectsDeps {
  homedir?: () => string;
}

/** Matches "claude"/"Claude" and also the dotfile convention "`.claude`"/"`.Claude`" (Claude
 *  Code's own home directory) — a leading dot is stripped before comparison, everything else
 *  must match exactly (not a substring match, so "claude-code" or "my-claude-notes" don't count). */
function isClaudeDirName(name: string): boolean {
  return name.replace(/^\./, '').toLowerCase() === 'claude';
}

/**
 * Find every directory named "claude" (see `isClaudeDirName`), searching recursively from
 * `root`. A match is not itself searched further — its full contents are captured by
 * `appendTree` instead, so a nested "claude" folder inside a match isn't double-reported as its
 * own match. Symlinked directories are never followed, to avoid link loops and escaping `root`.
 * Unreadable directories (permissions, etc.) are skipped rather than aborting the whole scan.
 */
export async function findClaudeDirs(root: string): Promise<string[]> {
  if (isClaudeDirName(path.basename(root))) {
    return [root];
  }

  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (isClaudeDirName(entry.name)) {
        matches.push(fullPath);
        continue;
      }
      await walk(fullPath);
    }
  }

  await walk(root);
  return matches;
}

/**
 * Depth-first append of `dir`'s full contents (recursive, no exclusions) to `lines` as an
 * indented markdown list, one entry per file/directory, each annotated with basic metadata
 * (size, extension, created/modified times for files). Never reads file *contents* — only
 * filesystem metadata — so nothing from inside these folders leaves the machine except names
 * and stats.
 */
async function appendTree(lines: string[], dir: string, depth: number): Promise<void> {
  const indent = '  '.repeat(depth);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    lines.push(`${indent}- ⚠️ (unreadable: ${(err as Error).message})`);
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue; // never follow symlinks — avoids link loops and escaping dir
    }

    const fullPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch (err) {
      lines.push(`${indent}- ${entry.name} (unreadable: ${(err as Error).message})`);
      continue;
    }

    if (entry.isDirectory()) {
      lines.push(`${indent}- 📁 \`${entry.name}/\` — modified ${stat.mtime.toISOString()}`);
      await appendTree(lines, fullPath, depth + 1);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name) || '(none)';
    const kb = (stat.size / 1024).toFixed(1);
    lines.push(
      `${indent}- 📄 \`${entry.name}\` — ${kb} KB, ${ext}, ` +
        `created ${stat.birthtime.toISOString()}, modified ${stat.mtime.toISOString()}`
    );
  }
}

export async function run(opts: MapClaudeProjectsOptions, deps: MapClaudeProjectsDeps = {}): Promise<number> {
  try {
    const root = opts.root ?? (deps.homedir ?? os.homedir)();
    const matches = await findClaudeDirs(root);

    if (matches.length === 0) {
      if (opts.json) {
        logger.json({ ok: true, matches: 0, matchedPaths: [] });
      } else {
        logger.info(`No folders named "claude" found under ${root}.`);
      }
      return ExitCode.OK;
    }

    const lines: string[] = [
      '# Claude Folders Map',
      '',
      `Generated ${new Date().toISOString()} — ${matches.length} folder(s) matching "claude" found under \`${root}\`.`,
      '',
    ];
    for (const match of matches) {
      lines.push(`## ${match}`, '');
      await appendTree(lines, match, 0);
      lines.push('');
    }
    const markdown = `${lines.join('\n')}\n`;

    const tmpPath = path.join(os.tmpdir(), `coolhand-claude-map-${randomBytes(6).toString('hex')}.md`);
    await fs.writeFile(tmpPath, markdown, 'utf8');

    try {
      const result = await uploadClientFile(
        {
          filePath: tmpPath,
          name: 'Claude Folders Map',
          fileType: 'report',
          description: `File tree map of ${matches.length} folder(s) named "claude" under ${root} (names and metadata only — no file contents).`,
          metadata: { source: 'map-claude-projects', matchCount: matches.length, root },
        },
        { clientId: opts.clientId, dryRun: opts.dryRun }
      );

      const mb = (result.sizeBytes / (1024 * 1024)).toFixed(2);

      if (opts.json) {
        logger.json({
          ok: true,
          dryRun: result.status === 'dry-run',
          matches: matches.length,
          matchedPaths: matches,
          sizeBytes: result.sizeBytes,
          result: result.response,
        });
      } else if (result.status === 'dry-run') {
        logger.info(`Dry run: found ${matches.length} folder(s), map is ${mb}MB. Nothing sent.`);
      } else {
        logger.info(
          `Uploaded a map of ${matches.length} folder(s) (${mb}MB) as client file ` +
            `"${result.response?.name}" (id: ${result.response?.id}).`
        );
      }
      return ExitCode.OK;
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof CliError) {
      if (opts.json) {
        logger.json({ ok: false, error: err.code, message: redact(err.message) });
      } else {
        logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      }
      return err.exitCode;
    }
    throw err;
  }
}

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
 * own match. A *symlinked* "claude"/".claude" directory still counts as a match (dotfile
 * managers like chezmoi/Stow/yadm commonly manage `~/.claude` this way) — only non-matching
 * symlinked directories are skipped during further recursion, to avoid link loops and escaping
 * `root`. Unreadable directories (permissions, etc.) are skipped rather than aborting the whole
 * scan.
 */
export async function findClaudeDirs(root: string): Promise<string[]> {
  if (isClaudeDirName(path.basename(root))) {
    // Unlike every match found via walk() below, root is handed to us directly rather than
    // discovered via fs.readdir — nothing has confirmed it actually exists or is a directory
    // yet. Without this check, a nonexistent or wrong-type --root (e.g. `--root ~/.claude` on a
    // machine where that path doesn't exist — exactly the usage docs/commands.md recommends)
    // would be reported as a real match, and the empty/failing walk downstream would silently
    // produce and upload a near-empty "successful" report instead of a clear "not found" result.
    const rootStat = await fs.stat(root).catch(() => null);
    return rootStat?.isDirectory() ? [root] : [];
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
      const fullPath = path.join(dir, entry.name);

      if (isClaudeDirName(entry.name)) {
        if (entry.isDirectory()) {
          matches.push(fullPath);
        } else if (entry.isSymbolicLink()) {
          // Resolve the target to confirm it's actually a directory before recording it as a
          // match (a symlink to a plain file literally named "claude" wouldn't be one). A
          // broken/looping symlink fails fs.stat and is simply not reported as a match.
          const targetStat = await fs.stat(fullPath).catch(() => null);
          if (targetStat?.isDirectory()) {
            matches.push(fullPath);
          }
        }
        continue; // matched (or matched-by-name-but-not-a-dir) — never searched further either way
      }

      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue; // non-matching symlink or non-directory — never followed
      }
      await walk(fullPath);
    }
  }

  await walk(root);
  return matches;
}

/**
 * Wrap `text` in a markdown inline-code span that's safe even if `text` itself contains
 * backticks (a literal backtick in a filename would otherwise prematurely close the span and
 * mangle the rest of the report) — CommonMark's own rule: a code span delimited by N backticks
 * can safely contain any run of fewer than N backticks, as long as it's not at the very edge.
 *
 * A literal newline (legal in a POSIX filename) is replaced with a visible placeholder rather
 * than left as-is: CommonMark only collapses line endings *inside* a code span when the span
 * stays within one block, which doesn't hold across an ATX heading's own line boundary (this
 * function is also used to build `## <match>` headings) — an embedded `\n` would otherwise split
 * the heading into two lines, one with an unclosed code span.
 */
function mdInlineCode(text: string): string {
  const singleLine = text.replace(/\r\n|\r|\n/g, '␤');
  const runs = singleLine.match(/`+/g);
  const longestRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  if (longestRun === 0) {
    return `\`${singleLine}\``;
  }
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${singleLine} ${fence}`;
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
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      // Resolve the target only to tell a file from a directory — a symlinked directory is
      // never followed (avoids link loops and escaping dir), but a symlinked file is safe to
      // list (using the target's metadata) since nothing recurses into it.
      let targetStat;
      try {
        targetStat = await fs.stat(fullPath);
      } catch (err) {
        lines.push(`${indent}- ${mdInlineCode(entry.name)} (broken symlink: ${(err as Error).message})`);
        continue;
      }
      if (targetStat.isDirectory()) {
        lines.push(`${indent}- 📁 ${mdInlineCode(`${entry.name}/`)} (symlink to a directory, not followed)`);
        continue;
      }
      const ext = path.extname(entry.name) || '(none)';
      const kb = (targetStat.size / 1024).toFixed(1);
      lines.push(
        `${indent}- 📄 ${mdInlineCode(entry.name)} (symlink) — ${kb} KB, ${ext}, ` +
          `created ${targetStat.birthtime.toISOString()}, modified ${targetStat.mtime.toISOString()}`
      );
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch (err) {
      lines.push(`${indent}- ${mdInlineCode(entry.name)} (unreadable: ${(err as Error).message})`);
      continue;
    }

    if (entry.isDirectory()) {
      lines.push(`${indent}- 📁 ${mdInlineCode(`${entry.name}/`)} — modified ${stat.mtime.toISOString()}`);
      await appendTree(lines, fullPath, depth + 1);
      continue;
    }

    if (!entry.isFile()) {
      // A special file — socket, FIFO, block/char device. Rare under a Claude config directory,
      // but "no exclusions" means it still gets a line rather than vanishing without a trace.
      lines.push(`${indent}- ${mdInlineCode(entry.name)} (special file, not a regular file or directory)`);
      continue;
    }

    const ext = path.extname(entry.name) || '(none)';
    const kb = (stat.size / 1024).toFixed(1);
    lines.push(
      `${indent}- 📄 ${mdInlineCode(entry.name)} — ${kb} KB, ${ext}, ` +
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
      `Generated ${new Date().toISOString()} — ${matches.length} folder(s) matching "claude" found under ${mdInlineCode(root)}.`,
      '',
    ];
    for (const match of matches) {
      // mdInlineCode also replaces any stray newline byte in a directory name, not just
      // backticks — a heading built from a raw, unescaped path could otherwise be split across
      // lines (see mdInlineCode's own doc comment for why the newline handling lives there).
      lines.push(`## ${mdInlineCode(match)}`, '');
      await appendTree(lines, match, 0);
      lines.push('');
    }
    const markdown = `${lines.join('\n')}\n`;

    if (opts.output) {
      // Same sensitivity as the upload temp file below (real filenames from every matched
      // folder) — 0o600, and written before the upload attempt so it's available for inspection
      // even if the upload itself fails.
      await fs.writeFile(opts.output, markdown, { encoding: 'utf8', mode: 0o600 });
    }

    const tmpPath = path.join(os.tmpdir(), `coolhand-claude-map-${randomBytes(6).toString('hex')}.md`);
    // The report lists real filenames (and thus can be sensitive) from every matched folder —
    // 0o600 keeps it unreadable by other local users for as long as it exists on disk, matching
    // the mode used for other sensitive files elsewhere (src/config.ts, capture-state.ts).
    await fs.writeFile(tmpPath, markdown, { encoding: 'utf8', mode: 0o600 });

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
          ...(opts.output && { outputPath: opts.output }),
          result: result.response,
        });
      } else if (result.status === 'dry-run') {
        logger.info(
          `Dry run: found ${matches.length} folder(s), map is ${mb}MB. Nothing sent.` +
            (opts.output ? ` Report written to ${opts.output}.` : '')
        );
      } else {
        logger.info(
          `Uploaded a map of ${matches.length} folder(s) (${mb}MB) as client file ` +
            `"${result.response?.name}" (id: ${result.response?.id}).` +
            (opts.output ? ` Report also written to ${opts.output}.` : '')
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

import { promises as fs } from 'fs';
import * as path from 'path';
import type { DownloadedClientFile } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getClientFileClient, mapClientFileHttpError } from '../api/client-file-client.js';
import type { DownloadClientFileOptions } from '../types.js';

/**
 * Reduces a server-supplied filename to a safe single path segment. `path.basename` alone leaves
 * Windows-style `\` separators intact on POSIX and passes `.`/`..` through, either of which could
 * place the file outside the intended directory.
 */
export function safeFilename(raw: string | null, fallback: string): string {
  const last = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = path.basename(last).replace(/[\x00-\x1f\x7f]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned;
}

async function resolveDestination(opts: DownloadClientFileOptions, downloaded: DownloadedClientFile): Promise<string> {
  const filename = safeFilename(downloaded.filename, `client-file-${opts.id}`);
  if (opts.output === undefined) {
    return path.resolve(filename);
  }
  const existing = await fs.stat(opts.output).catch(() => null);
  return existing?.isDirectory() ? path.join(opts.output, filename) : opts.output;
}

export async function run(opts: DownloadClientFileOptions): Promise<number> {
  try {
    const coolhand = await getClientFileClient({ clientId: opts.clientId });

    let downloaded: DownloadedClientFile;
    try {
      downloaded = await coolhand.downloadClientFile(opts.id);
    } catch (err) {
      throw mapClientFileHttpError(err, `Client file "${opts.id}" not found (or does not belong to this client).`);
    }

    const destination = await resolveDestination(opts, downloaded);
    try {
      // 'wx' fails atomically if the path exists, so a concurrent file is never clobbered without --force.
      await fs.writeFile(destination, downloaded.content, { flag: opts.force ? 'w' : 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CliError(
          'OUTPUT_EXISTS',
          `Refusing to overwrite existing file at ${destination}. Use --force to overwrite it or --output to choose another path.`
        );
      }
      throw new CliError('CLIENT_FILE_ERROR', `Cannot write "${destination}": ${(err as Error).message}`);
    }

    const sizeBytes = downloaded.content.length;
    if (opts.json) {
      logger.json({
        ok: true,
        result: { id: opts.id, path: destination, sizeBytes, contentType: downloaded.contentType },
      });
    } else {
      logger.info(`Saved client file ${opts.id} to ${destination} (${sizeBytes} bytes).`);
    }
    return ExitCode.OK;
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

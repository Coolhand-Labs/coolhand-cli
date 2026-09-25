import { readFile } from 'node:fs/promises';
import type { BulkLinkFeedbackResult } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getFeedbackClient } from '../api/feedback-client.js';
import type { LinkFeedbackOptions } from '../types.js';

/** Ids may be separated by any whitespace or commas, so a file or pipe can be one-per-line or CSV. */
export function parseIds(text: string): string[] {
  return text.split(/[\s,]+/).filter((s) => s.length > 0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function collectIds(opts: LinkFeedbackOptions): Promise<string[]> {
  const ids = [...opts.feedbackIds];
  if (opts.file !== undefined) {
    let text: string;
    try {
      text = opts.file === '-' ? await readStdin() : await readFile(opts.file, 'utf8');
    } catch (err) {
      throw new CliError('INVALID_ARGS', `Could not read feedback ids from ${opts.file}: ${(err as Error).message}`);
    }
    ids.push(...parseIds(text));
  }
  if (ids.length === 0) {
    throw new CliError('INVALID_ARGS', 'link-feedback requires at least one <feedback-id> (as arguments or via --file)');
  }
  // Repeats would otherwise be counted as already_linked by the server.
  return [...new Set(ids)];
}

function mapLinkError(err: unknown, optimizationId: string): CliError {
  const status = (err as { status?: number }).status;
  if (status === 401) {
    return new CliError(
      'FEEDBACK_ERROR',
      "The stored private key was rejected (linking feedback requires a private key). Run 'coolhand login --scope private' to re-authenticate."
    );
  }
  if (status === 404) {
    return new CliError('FEEDBACK_ERROR', `Optimization "${optimizationId}" not found (or does not belong to this client).`);
  }
  if (status !== undefined) {
    return new CliError('FEEDBACK_ERROR', `Link request failed (${status}): ${(err as Error).message}`);
  }
  return new CliError('FEEDBACK_ERROR', `Link request failed: ${(err as Error).message}`);
}

export async function run(opts: LinkFeedbackOptions): Promise<number> {
  try {
    const ids = await collectIds(opts);
    const coolhand = await getFeedbackClient({ clientId: opts.clientId });

    let result: BulkLinkFeedbackResult;
    try {
      result = await coolhand.bulkLinkFeedback(opts.optimizationId, ids, opts.note !== undefined ? { note: opts.note } : {});
    } catch (err) {
      throw mapLinkError(err, opts.optimizationId);
    }

    const failed = result.errored > 0;
    if (opts.json) {
      logger.json({ ok: !failed, result });
    } else {
      logger.info(`Linked: ${result.linked}`);
      logger.info(`Already linked: ${result.already_linked}`);
      logger.info(`Errored: ${result.errored}`);
      if (result.not_found.length > 0) {
        logger.info(`Not found (${result.not_found.length}): ${result.not_found.join(', ')}`);
      }
    }
    return failed ? ExitCode.USER_ERROR : ExitCode.OK;
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

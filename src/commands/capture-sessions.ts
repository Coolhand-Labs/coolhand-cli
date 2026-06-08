import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { scanSessions } from '../sessions/claude-scanner.js';
import { logRequest } from '../log-request.js';
import type { CaptureSessionsOptions } from '../types.js';

/** Errors that apply to every turn (auth/config), so the run should abort, not keep retrying. */
const FATAL_CODES = new Set(['NOT_CONFIGURED', 'CLIENT_NOT_FOUND', 'INVALID_BASE_URL']);

export async function run(opts: CaptureSessionsOptions): Promise<number> {
  try {
    const { envelopes, sessionCount } = await scanSessions();

    if (opts.dryRun) {
      if (opts.json) {
        logger.json({ ok: true, dryRun: true, sessions: sessionCount, turns: envelopes.length });
      } else {
        logger.info(
          `Dry run: found ${sessionCount} session(s), ${envelopes.length} turn(s) to submit. Nothing sent.`
        );
      }
      return ExitCode.OK;
    }

    let submitted = 0;
    let failed = 0;
    for (const envelope of envelopes) {
      try {
        await logRequest(envelope, { clientId: opts.clientId });
        submitted += 1;
      } catch (err) {
        if (err instanceof CliError && FATAL_CODES.has(err.code)) {
          throw err;
        }
        failed += 1;
        logger.warn(`Failed to submit turn: ${redact((err as Error).message)}`);
      }
    }

    if (opts.json) {
      logger.json({ ok: failed === 0, sessions: sessionCount, submitted, failed });
    } else {
      const failureNote = failed > 0 ? `, ${failed} failed` : '';
      logger.info(`Submitted ${submitted} turn(s) from ${sessionCount} session(s)${failureNote}.`);
    }

    return failed === 0 ? ExitCode.OK : ExitCode.USER_ERROR;
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

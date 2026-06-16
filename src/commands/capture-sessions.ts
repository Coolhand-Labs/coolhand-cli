import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { scanSessions, sessionIdOf } from '../sessions/claude-scanner.js';
import {
  loadCaptureState,
  isSubmitted,
  markSubmitted,
  saveCaptureState,
} from '../sessions/capture-state.js';
import { loadConfig, getClient } from '../config.js';
import { logRequest } from '../log-request.js';
import type { CaptureSessionsOptions } from '../types.js';

/** Errors that apply to every session (auth/config), so the run should abort, not keep retrying. */
const FATAL_CODES = new Set(['NOT_CONFIGURED', 'CLIENT_NOT_FOUND', 'INVALID_BASE_URL']);

export async function run(opts: CaptureSessionsOptions): Promise<number> {
  try {
    const { envelopes, sessionCount } = await scanSessions();

    // Scope the "already submitted" list to the client we're submitting to, so the same sessions
    // can be sent to a different client if needed.
    const cfg = await loadConfig();
    const stateClientId = getClient(cfg, opts.clientId)?.client_id ?? opts.clientId ?? '_default';
    const state = await loadCaptureState();

    const pending = envelopes.filter((e) => !isSubmitted(state, stateClientId, sessionIdOf(e)));
    const skipped = envelopes.length - pending.length;

    if (opts.dryRun) {
      if (opts.json) {
        logger.json({ ok: true, dryRun: true, sessions: sessionCount, toSubmit: pending.length, skipped });
      } else {
        logger.info(
          `Dry run: found ${sessionCount} session(s), ${pending.length} new to submit, ` +
            `${skipped} already submitted. Nothing sent.`
        );
      }
      return ExitCode.OK;
    }

    let submitted = 0;
    let failed = 0;
    try {
      for (const envelope of pending) {
        try {
          await logRequest(envelope, { clientId: opts.clientId });
          markSubmitted(state, stateClientId, sessionIdOf(envelope));
          submitted += 1;
        } catch (err) {
          if (err instanceof CliError && FATAL_CODES.has(err.code)) {
            throw err;
          }
          failed += 1;
          logger.warn(`Failed to submit session: ${redact((err as Error).message)}`);
        }
      }
    } finally {
      // Persist whatever we recorded, even if a fatal error aborts the run partway.
      try {
        await saveCaptureState(state);
      } catch (err) {
        logger.warn(`Failed to save capture state: ${redact((err as Error).message)}`);
      }
    }

    if (opts.json) {
      logger.json({ ok: failed === 0, sessions: sessionCount, submitted, skipped, failed });
    } else {
      const failureNote = failed > 0 ? `, ${failed} failed` : '';
      const skippedNote = skipped > 0 ? `, ${skipped} already submitted` : '';
      logger.info(
        `Submitted ${submitted} session(s) of ${sessionCount} scanned${skippedNote}${failureNote}.`
      );
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

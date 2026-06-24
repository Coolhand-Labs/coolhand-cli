import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { scanSessions, sessionIdOf, type CaptureEnvelope } from '../sessions/claude-scanner.js';
import {
  loadCaptureState,
  getTurnsSubmitted,
  recordSubmission,
  saveCaptureState,
  V1_MIGRATION_SENTINEL,
  type CaptureState,
} from '../sessions/capture-state.js';
import { fetchLastSync } from '../api/last-sync.js';
import { loadConfig, getClient } from '../config.js';
import { logRequest } from '../log-request.js';
import type { AnalyzeClaudeSessionsOptions } from '../types.js';

/** Errors that apply to every session (auth/config), so the run should abort, not keep retrying. */
const FATAL_CODES = new Set(['NOT_CONFIGURED', 'CLIENT_NOT_FOUND', 'INVALID_BASE_URL']);

/**
 * Reference cutoff for the mtime pre-filter: local `lastSyncAt` → server `last_sync` → epoch.
 *
 * Local `lastSyncAt` is preferred: it is only advanced when a run completes with zero failures,
 * so it accurately reflects the point past which all sessions have been submitted. Using server
 * time instead would advance the cutoff past sessions that failed to submit on a prior run,
 * causing the mtime filter to skip them permanently. Server time is also on a different clock
 * from local file mtimes, so clock skew can silently exclude freshly-written files.
 */
function resolveReferenceTime(serverTime: Date | null, state: CaptureState): Date {
  if (state.lastSyncAt) {
    const local = new Date(state.lastSyncAt);
    if (!Number.isNaN(local.getTime())) {
      return local;
    }
  }
  if (serverTime) {
    return serverTime;
  }
  return new Date(0);
}

export async function run(opts: AnalyzeClaudeSessionsOptions): Promise<number> {
  try {
    // (1) Resolve the client and load local state up front — both feed the reference time and the
    // per-session turn-count comparison.
    const cfg = await loadConfig();
    const stateClientId = getClient(cfg, opts.clientId)?.client_id ?? opts.clientId ?? '_default';
    const state = await loadCaptureState();

    // (2) Work out the reference timestamp. The server call degrades to null (endpoint may not exist
    // yet), in which case we fall back to the local lastSyncAt, then to epoch.
    const serverTime = await fetchLastSync({ clientId: opts.clientId });
    const referenceTime = resolveReferenceTime(serverTime, state);

    // (3) Scan, skipping files unchanged since the reference time.
    const { envelopes, sessionCount } = await scanSessions({ sinceTime: referenceTime });

    // (4) Classify each examined session as new / updated / unchanged by comparing its current turn
    // count against what we last submitted. The turn-count guard — not the mtime filter — is what
    // makes re-uploads correct.
    const toSubmit: CaptureEnvelope[] = [];
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    for (const envelope of envelopes) {
      const sessionId = sessionIdOf(envelope);
      const already = getTurnsSubmitted(state, stateClientId, sessionId);
      if (already === 0) {
        newCount += 1;
        toSubmit.push(envelope);
      } else if (already === V1_MIGRATION_SENTINEL) {
        // Session was submitted under v1 but its turn count was not recorded. Record the actual
        // count now so future runs can detect growth, without re-submitting (server already has it).
        recordSubmission(state, stateClientId, sessionId, envelope.turnCount);
        unchangedCount += 1;
      } else if (envelope.turnCount > already) {
        updatedCount += 1;
        toSubmit.push(envelope);
      } else {
        unchangedCount += 1;
      }
    }

    if (opts.dryRun) {
      if (opts.json) {
        logger.json({
          ok: true,
          dryRun: true,
          scanned: sessionCount,
          new: newCount,
          updated: updatedCount,
          unchanged: unchangedCount,
          toSubmit: toSubmit.length,
        });
      } else {
        logger.info(
          `Dry run: ${newCount} new session(s), ${updatedCount} updated, ` +
            `${unchangedCount} unchanged (${sessionCount} scanned). Nothing sent.`
        );
      }
      return ExitCode.OK;
    }

    // (5) Submit new + updated sessions, recording the full current turn count on success, then stamp
    // lastSyncAt and persist — even if a fatal error aborts the run partway.
    let submittedNew = 0;
    let submittedUpdated = 0;
    let failed = 0;
    try {
      for (const envelope of toSubmit) {
        const sessionId = sessionIdOf(envelope);
        const prior = getTurnsSubmitted(state, stateClientId, sessionId);
        try {
          await logRequest(envelope, { clientId: opts.clientId });
          recordSubmission(state, stateClientId, sessionId, envelope.turnCount);
          if (prior === 0) {
            submittedNew += 1;
          } else {
            submittedUpdated += 1;
          }
        } catch (err) {
          if (err instanceof CliError && FATAL_CODES.has(err.code)) {
            throw err;
          }
          failed += 1;
          logger.warn(`Failed to submit session: ${redact((err as Error).message)}`);
        }
      }
      // Advance the local cutoff ONLY when nothing failed. A failed-but-grown session keeps its
      // older mtime; if we moved the cutoff past it, the next run's mtime filter would skip it and
      // the growth would be lost. Prefer the server's authoritative time; otherwise stamp now.
      if (failed === 0) {
        state.lastSyncAt = (serverTime ?? new Date()).toISOString();
      }
    } finally {
      try {
        await saveCaptureState(state);
      } catch (err) {
        logger.warn(`Failed to save capture state: ${redact((err as Error).message)}`);
      }
    }

    if (opts.json) {
      logger.json({
        ok: failed === 0,
        scanned: sessionCount,
        new: submittedNew,
        updated: submittedUpdated,
        unchanged: unchangedCount,
        failed,
      });
    } else {
      const failureNote = failed > 0 ? `, ${failed} failed` : '';
      logger.info(
        `Submitted ${submittedNew} new, ${submittedUpdated} updated, ` +
          `${unchangedCount} unchanged (${sessionCount} scanned)${failureNote}.`
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

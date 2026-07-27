import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { scanSessions, sessionIdOf, type CaptureEnvelope, type ScanResult } from '../sessions/claude-scanner.js';
import { scanCoworkSessions } from '../sessions/cowork-scanner.js';
import {
  loadCaptureState,
  getTurnsSubmitted,
  recordSubmission,
  saveCaptureState,
  V1_MIGRATION_SENTINEL,
  type CaptureState,
} from '../sessions/capture-state.js';
import { fetchLastSync } from '../api/last-sync.js';
import { loadConfig, resolveClient } from '../config.js';
import { logRequest } from '../log-request.js';
import { parseWhen } from '../parse-when.js';
import { buildSessionFilter } from '../sessions/session-filter.js';
import type { AnalyzeClaudeSessionsOptions } from '../types.js';

/** Errors that apply to every session (auth/config), so the run should abort, not keep retrying. */
// Errors that apply to every session (auth/config) — abort the whole run instead of
// counting as a per-session failure and retrying. INVALID_ARGS is included because
// logRequest validates its inputs and would throw INVALID_ARGS on a malformed envelope
// that would fail every session identically.
const FATAL_CODES = new Set(['NOT_CONFIGURED', 'CLIENT_NOT_FOUND', 'INVALID_BASE_URL', 'INVALID_ARGS']);

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

/**
 * True when any per-run filter flag narrowed this scan. A narrowed run must NOT advance the
 * sync cutoffs: sessions excluded this run would otherwise fall behind the new cutoff and be
 * skipped by every future default run — silently and permanently.
 */
export function isNarrowingRun(opts: AnalyzeClaudeSessionsOptions): boolean {
  return Boolean(
    opts.since ||
      opts.until ||
      opts.projectsDir ||
      (opts.projects && opts.projects.length > 0) ||
      (opts.excludeProjects && opts.excludeProjects.length > 0)
  );
}

export async function run(opts: AnalyzeClaudeSessionsOptions): Promise<number> {
  try {
    // (1) Resolve the client and load local state up front — both feed the reference time and the
    // per-session turn-count comparison. resolveClient runs the full priority chain (--client-id,
    // COOLHAND_CLIENT_ID env, default, auto-pick, TTY prompt) and emits "Client: name (id)" to
    // stderr. Using the resolved client_id as the state key ensures consistent tracking regardless
    // of which selection path was used.
    //
    // NOT_CONFIGURED is caught and treated as "unauthenticated" only when no clients are stored
    // at all, so that --dry-run still works without credentials (same behaviour as before this
    // branch). If clients exist but resolution failed (e.g. no default on a non-TTY), the error
    // propagates so the user sees a clear message rather than a silent no-op.
    // Any other error (e.g. CLIENT_NOT_FOUND for a bad --client-id) also propagates.
    const cfg = await loadConfig();
    let stateClientId = '_default';
    let resolvedClientId: string | undefined;
    try {
      const client = await resolveClient(cfg, opts.clientId);
      stateClientId = client.client_id;
      resolvedClientId = client.client_id;
    } catch (err) {
      if (
        !(err instanceof CliError) ||
        err.code !== 'NOT_CONFIGURED' ||
        Object.keys(cfg.clients).length > 0
      ) {
        throw err;
      }
    }
    const state = await loadCaptureState();

    // (2) Work out the reference timestamp. serverTime is only used when local state is absent or
    // invalid (resolveReferenceTime prefers lastSyncAt), so skip the round-trip when unneeded.
    const localSyncAt = state.lastSyncAt ? new Date(state.lastSyncAt) : null;
    const needsServerTime = !localSyncAt || Number.isNaN(localSyncAt.getTime());
    // Pass the resolved client_id so fetchLastSync and logRequest skip re-resolution.
    // Skip fetchLastSync on the unauthenticated path (no clients stored, resolvedClientId
    // undefined): it would call getClient with no id, get undefined, and return null anyway.
    const serverTime = needsServerTime && resolvedClientId !== undefined
      ? await fetchLastSync({ clientId: resolvedClientId })
      : null;
    const referenceTime = resolveReferenceTime(serverTime, state);

    // (3) Stamp the cutoff before scanning. Any transcript written after this point will have an
    // mtime >= runStartedAt and will be picked up by the next run's filter — closing the window
    // where a turn added during the submit loop (between scan and lastSyncAt stamp) would be
    // silently skipped because its mtime fell before a later timestamp.
    const runStartedAt = new Date();

    // Cowork sessions have their own independent mtime cutoff, starting at epoch when coworkLastSyncAt
    // is absent. Unlike Claude Code, we don't fall back to serverTime here: serverTime comes from the
    // Claude Code collector and predates any Cowork uploads, so using it would silently skip
    // never-submitted Cowork history on a reset or second-machine scenario.
    const coworkSinceTime = state.coworkLastSyncAt ? new Date(state.coworkLastSyncAt) : new Date(0);

    // An explicit --since replaces BOTH incremental cutoffs: the user is asking for a window, and
    // the turn-count guard still prevents duplicate uploads when that window revisits old sessions.
    const sinceOverride = opts.since ? parseWhen(opts.since, { now: runStartedAt, boundary: 'start' }) : null;
    const untilTime = opts.until ? parseWhen(opts.until, { now: runStartedAt, boundary: 'end' }) : null;
    if (sinceOverride && untilTime && sinceOverride.getTime() > untilTime.getTime()) {
      throw new CliError('INVALID_ARGS', `--since (${opts.since}) is after --until (${opts.until}).`);
    }

    // Everything below runs on metadata only (folder, mtime) — a session rejected here is
    // counted as filtered and its transcript is never read from disk.
    const hasContentFilter =
      untilTime !== null ||
      (opts.projects?.length ?? 0) > 0 ||
      (opts.excludeProjects?.length ?? 0) > 0;
    const preFilter = hasContentFilter
      ? buildSessionFilter({
          untilMs: untilTime?.getTime(),
          includeProjects: opts.projects,
          excludeProjects: opts.excludeProjects,
        })
      : undefined;

    // --projects-dir redirects the scan to a caller-chosen directory (e.g. a curated export for
    // a compliance-scoped run); Cowork sessions live under a separate, fixed macOS path that has
    // no equivalent override, so skip Cowork entirely rather than silently including sessions
    // from the default location alongside the redirected Claude Code scan.
    const [claudeResult, coworkResult] = await Promise.all([
      scanSessions({
        projectsDir: opts.projectsDir,
        sinceTime: sinceOverride ?? referenceTime,
        preFilter,
      }),
      opts.projectsDir
        ? Promise.resolve<ScanResult>({ envelopes: [], sessionCount: 0, filteredOut: 0, ok: true })
        : scanCoworkSessions({ sinceTime: sinceOverride ?? coworkSinceTime, preFilter }),
    ]);
    const envelopes = [...claudeResult.envelopes, ...coworkResult.envelopes];
    const sessionCount = claudeResult.sessionCount + coworkResult.sessionCount;
    const filteredCount = claudeResult.filteredOut + coworkResult.filteredOut;

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
          filtered: filteredCount,
          new: newCount,
          updated: updatedCount,
          unchanged: unchangedCount,
          toSubmit: toSubmit.length,
        });
      } else {
        const filteredNote = filteredCount > 0 ? `, ${filteredCount} filtered out` : '';
        logger.info(
          `Dry run: ${newCount} new session(s), ${updatedCount} updated, ` +
            `${unchangedCount} unchanged (${sessionCount} scanned${filteredNote}). Nothing sent.`
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
          await logRequest(envelope, { clientId: resolvedClientId });
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
      // Advance the local cutoff ONLY when nothing failed AND no filter narrowed the run. A
      // failed-but-grown session keeps its older mtime; if we moved the cutoff past it, the next
      // run's mtime filter would skip it and the growth would be lost. The same applies to any
      // session a filter excluded this run — advancing would hide it from every future default
      // run. Use runStartedAt (captured before scanSessions) so any transcript written during the
      // submit loop has mtime >= runStartedAt and is caught by the next run.
      if (failed === 0 && !isNarrowingRun(opts)) {
        state.lastSyncAt = runStartedAt.toISOString();
        // Only advance Cowork's cutoff when the scan actually read the directory. A swallowed
        // readdir error returns ok:false; advancing the cutoff in that case would permanently hide
        // pre-existing audit.jsonl files whose mtimes predate the new stamp.
        if (coworkResult.ok) {
          state.coworkLastSyncAt = runStartedAt.toISOString();
        }
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
        filtered: filteredCount,
        new: submittedNew,
        updated: submittedUpdated,
        unchanged: unchangedCount,
        failed,
      });
    } else {
      const failureNote = failed > 0 ? `, ${failed} failed` : '';
      const filteredNote = filteredCount > 0 ? `, ${filteredCount} filtered out` : '';
      const narrowingNote = isNarrowingRun(opts) ? ' (sync cutoff not advanced — filters active)' : '';
      logger.info(
        `Submitted ${submittedNew} new, ${submittedUpdated} updated, ` +
          `${unchangedCount} unchanged (${sessionCount} scanned${filteredNote})${failureNote}.${narrowingNote}`
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

import * as os from 'os';
import * as path from 'path';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, resolveClientForDryRun } from '../config.js';
import { uploadClientFile } from '../upload-client-file.js';
import { defaultCoworkSessionsDir } from '../sessions/cowork-scanner.js';
import { sanitizeProjectKey } from '../sessions/session-filter.js';
import {
  findSkillFiles,
  dedupeSkillFiles,
  type SkillRoot,
  type SkillCandidate,
  type SkillSourceKind,
} from '../skills/skill-scanner.js';
import { loadSkillState, getUploadRecord, recordUpload, saveSkillState } from '../skills/skill-state.js';
import type { SyncSkillsOptions } from '../types.js';

export interface SyncSkillsDeps {
  /** Overrides `os.homedir()` for the `authored` and `claude-code` default roots only. The
   *  `installed` root always comes from the canonical `defaultCoworkSessionsDir()` (reused as-is
   *  from cowork-scanner.ts, deliberately not re-derived here to avoid drift) — that function has
   *  no override parameter of its own and always reads the real `os.homedir()`, so it does NOT
   *  move with this override. Note that mutating `process.env.HOME` in a test is not a substitute
   *  for this: Node's `os.homedir()` native binding does not reliably observe a `HOME` mutated
   *  after process start under Jest, which is why this injection point exists at all. */
  homedir?: () => string;
  /** Override the roots to scan, bypassing the default 3-root/--root/--source resolution
   *  entirely (including the `installed` root) — used by tests that need every root, including
   *  `installed`, pointed at a temp directory. */
  roots?: SkillRoot[];
}

/** Errors that apply to every candidate (auth/config), so the run should abort rather than fail
 *  identically for each remaining upload. Deliberately narrower than analyze-claude-sessions'
 *  FATAL_CODES: INVALID_ARGS from uploadClientFile here is a per-FILE condition (unreadable file,
 *  over the size cap) that can easily succeed for the next candidate, so it must NOT be fatal —
 *  unlike analyze-claude-sessions, where INVALID_ARGS comes from a malformed envelope shape that
 *  would fail identically for every session. NO_PRIVATE_KEY, absent from analyze-claude-sessions'
 *  set (logRequest uses the public-key tier), is fatal here because uploadClientFile always
 *  requires a private key — identical for every candidate, so retrying per-item is pointless. */
const FATAL_CODES = new Set(['NOT_CONFIGURED', 'CLIENT_NOT_FOUND', 'INVALID_BASE_URL', 'NO_PRIVATE_KEY']);

const VALID_SOURCE_KINDS: SkillSourceKind[] = ['authored', 'installed', 'claude-code'];

function defaultRoots(homedir: () => string): SkillRoot[] {
  return [
    { root: path.join(homedir(), 'Documents', 'Claude'), sourceKind: 'authored' },
    { root: defaultCoworkSessionsDir(), sourceKind: 'installed' },
    { root: path.join(homedir(), '.claude', 'skills'), sourceKind: 'claude-code' },
  ];
}

function resolveRoots(opts: SyncSkillsOptions, homedir: () => string): SkillRoot[] {
  if (opts.root) {
    return [{ root: opts.root, sourceKind: 'custom' }];
  }
  const roots = defaultRoots(homedir);
  if (!opts.sources || opts.sources.length === 0) {
    return roots;
  }
  const wanted = new Set(opts.sources.map((s) => s.toLowerCase()));
  for (const s of wanted) {
    if (!VALID_SOURCE_KINDS.includes(s as SkillSourceKind)) {
      throw new CliError('INVALID_ARGS', `--source must be one of: ${VALID_SOURCE_KINDS.join(', ')} (got "${s}")`);
    }
  }
  return roots.filter((r) => wanted.has(r.sourceKind));
}

/** Substring/case-insensitive match on skill name, using the same normalization
 *  (`sanitizeProjectKey`) as --project/--exclude-project so filter semantics stay consistent
 *  across commands. */
function matchesFilter(skillName: string, needles: string[]): boolean {
  const key = sanitizeProjectKey(skillName);
  return needles.some((needle) => key.includes(sanitizeProjectKey(needle)));
}

function applyNameFilters(candidates: SkillCandidate[], opts: SyncSkillsOptions): SkillCandidate[] {
  let result = candidates;
  const includeNeedles = opts.skills;
  if (includeNeedles && includeNeedles.length > 0) {
    result = result.filter((c) => matchesFilter(c.skillName, includeNeedles));
  }
  const excludeNeedles = opts.excludeSkills;
  if (excludeNeedles && excludeNeedles.length > 0) {
    result = result.filter((c) => !matchesFilter(c.skillName, excludeNeedles));
  }
  return result;
}

function describeCandidate(candidate: SkillCandidate): string {
  if (candidate.description) {
    return candidate.description;
  }
  const extraCopies = candidate.duplicateCount - 1;
  const copiesNote = extraCopies > 0 ? `, ${extraCopies} duplicate cop${extraCopies === 1 ? 'y' : 'ies'} found on this machine` : '';
  return `Claude skill "${candidate.skillName}" (source: ${candidate.sourceKind}${copiesNote})`;
}

export async function run(opts: SyncSkillsOptions, deps: SyncSkillsDeps = {}): Promise<number> {
  try {
    const cfg = await loadConfig();
    const client = await resolveClientForDryRun(cfg, opts.clientId);
    const stateClientId = client?.client_id ?? '_default';
    // Pass the already-resolved client_id downstream (not opts.clientId) so each per-skill
    // uploadClientFile() call takes the fast "explicit clientId" branch of its own internal
    // resolveClientForDryRun/resolveClient call instead of re-running the full priority chain —
    // in particular, never re-prompting interactively over a TTY once per skill upload. That
    // inner call still re-reads config.json and re-prints "Client: <name> (<id>)" to stderr once
    // per upload (resolveClient always does, with no silent/quiet option) — a known, accepted
    // cost of reusing uploadClientFile()'s shared core as-is rather than duplicating its
    // auth/dry-run/size-cap logic in a separate lower-level upload path.
    const resolvedClientId = client?.client_id;
    // Fail fast on a fully logged-out, non-dry-run invocation — mirrors the same guard inside
    // uploadClientFile() itself, but checked here too so a real run doesn't waste time scanning
    // and SHA-256-hashing every SKILL.md across all default roots only to fail on the very first
    // upload attempt.
    if (!client && !opts.dryRun) {
      throw new CliError('NOT_CONFIGURED', 'Not logged in. Run `coolhand login` to authenticate.');
    }

    const roots = deps.roots ?? resolveRoots(opts, deps.homedir ?? os.homedir);
    // Captured once, before the scan, so every candidate uploaded from this run reports the same
    // discoveredAt — stamping it per-candidate inside the upload loop instead would both misname
    // the field (it'd reflect upload time, not discovery time) and drift across a large batch.
    const discoveredAt = new Date().toISOString();
    const warnings: string[] = [];
    const discovered = await findSkillFiles(roots, (message) => warnings.push(message));
    for (const message of warnings) {
      logger.warn(message);
    }

    const allCandidates = dedupeSkillFiles(discovered);
    const candidates = applyNameFilters(allCandidates, opts);
    const duplicatesSkipped = discovered.length - allCandidates.length;
    const filteredOut = allCandidates.length - candidates.length;

    const state = await loadSkillState();

    const toUpload: SkillCandidate[] = [];
    let unchangedCount = 0;
    for (const candidate of candidates) {
      // The state key already embeds contentHash (see skill-state.ts's stateKey), so a hit here
      // means this exact content was already uploaded under this name — no separate hash
      // comparison needed.
      const record = getUploadRecord(state, stateClientId, candidate.skillName, candidate.contentHash);
      if (record && !opts.force) {
        unchangedCount += 1;
      } else {
        toUpload.push(candidate);
      }
    }

    if (opts.dryRun) {
      if (opts.json) {
        logger.json({
          ok: true,
          dryRun: true,
          found: discovered.length,
          duplicatesSkipped,
          filteredOut,
          new: toUpload.length,
          unchanged: unchangedCount,
        });
      } else {
        logger.info(
          `Dry run: found ${discovered.length} skill file(s), ${duplicatesSkipped} duplicate(s) skipped` +
            (filteredOut > 0 ? `, ${filteredOut} filtered out` : '') +
            ` — would upload ${toUpload.length}, ${unchangedCount} unchanged. Nothing sent.`
        );
      }
      return ExitCode.OK;
    }

    let uploaded = 0;
    let failed = 0;
    try {
      for (const candidate of toUpload) {
        try {
          const result = await uploadClientFile(
            {
              filePath: candidate.filePath,
              name: candidate.skillName,
              fileType: 'document',
              description: describeCandidate(candidate),
              metadata: {
                source: 'sync-skills',
                skillName: candidate.skillName,
                sourceKind: candidate.sourceKind,
                sourcePath: candidate.filePath,
                contentHash: candidate.contentHash,
                discoveredAt,
                duplicateCount: candidate.duplicateCount,
                root: candidate.root,
              },
            },
            // dryRun is deliberately omitted here (unlike map-claude-projects' single call) —
            // this loop is only ever reached after the opts.dryRun early-return above, so it
            // would always be false; sync-skills has its own independent dry-run short-circuit.
            { clientId: resolvedClientId }
          );
          recordUpload(state, stateClientId, candidate.skillName, candidate.contentHash, {
            contentHash: candidate.contentHash,
            uploadedAt: new Date().toISOString(),
            ...(result.response?.id && { clientFileId: result.response.id }),
          });
          uploaded += 1;
        } catch (err) {
          if (err instanceof CliError && FATAL_CODES.has(err.code)) {
            throw err;
          }
          failed += 1;
          logger.warn(`Failed to upload skill "${candidate.skillName}": ${redact((err as Error).message)}`);
        }
      }
    } finally {
      try {
        await saveSkillState(state);
      } catch (err) {
        logger.warn(`Failed to save skill state: ${redact((err as Error).message)}`);
      }
    }

    if (opts.json) {
      logger.json({
        ok: failed === 0,
        found: discovered.length,
        duplicatesSkipped,
        filteredOut,
        uploaded,
        unchanged: unchangedCount,
        failed,
      });
    } else {
      const failureNote = failed > 0 ? `, ${failed} failed` : '';
      logger.info(
        `Uploaded ${uploaded} skill(s), ${unchangedCount} unchanged` +
          (duplicatesSkipped > 0 ? `, ${duplicatesSkipped} duplicate(s) skipped` : '') +
          (filteredOut > 0 ? `, ${filteredOut} filtered out` : '') +
          `${failureNote}.`
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

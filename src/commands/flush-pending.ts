import { spawn } from 'child_process';
import { ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { uploadRecord } from '../pending-upload.js';
import {
  listPendingFiles,
  readPendingRecord,
  removePendingRecord,
  markFlushFailed,
  clearFlushFailed,
} from '../pending-store.js';

export interface FlushResult {
  uploaded: number;
  failed: number;
}

interface SpawnDeps {
  spawnFn?: typeof spawn;
}

/**
 * Upload every pending record. Deletes each on a confirmed success; on any failure the
 * file is kept and the "flush failed" marker is set so the next command can remind the
 * user (Option B). Clears the marker when everything uploaded cleanly.
 */
export async function flushPending(): Promise<FlushResult> {
  const files = await listPendingFiles();
  let uploaded = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const record = await readPendingRecord(file);
      const ok = await uploadRecord(record);
      if (ok) {
        await removePendingRecord(file);
        uploaded += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      logger.warn(`Failed to flush ${file}: ${redact((err as Error).message)}`);
    }
  }

  if (failed > 0) {
    await markFlushFailed();
  } else {
    await clearFlushFailed();
  }

  return { uploaded, failed };
}

/**
 * Launch the flush as a detached background process so the foreground command (login,
 * or a retry prompt) returns immediately. Mirrors the detached-spawn pattern used to
 * open the browser in `auth/open-browser.ts`. Best-effort: any failure just means the
 * records wait and retry on the next command.
 */
export function spawnBackgroundFlush(deps: SpawnDeps = {}): void {
  const spawnFn = deps.spawnFn ?? spawn;
  const cliPath = process.argv[1];
  if (!cliPath) {
    return;
  }
  try {
    const child = spawnFn(process.execPath, [cliPath, '__flush-pending'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // Swallow: the records remain in the pending store and retry next time.
    });
    child.unref();
  } catch {
    // Best-effort; nothing is lost because failed records stay in the store.
  }
}

/** Hidden `__flush-pending` command run by the detached background process. */
export async function run(): Promise<number> {
  const { failed } = await flushPending();
  return failed === 0 ? ExitCode.OK : ExitCode.USER_ERROR;
}

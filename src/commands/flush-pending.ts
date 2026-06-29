import { spawn } from 'child_process';
import { Coolhand, type LLMRequestLogFeedback } from 'coolhand-node';
import { ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';
import {
  listPendingFiles,
  readPendingRecord,
  removePendingRecord,
  markFlushFailed,
  clearFlushFailed,
  type PendingRecord,
} from '../pending-store.js';

export interface FlushResult {
  uploaded: number;
  failed: number;
}

interface SpawnDeps {
  spawnFn?: typeof spawn;
}

/**
 * Send a single saved record to Coolhand. Resolves the api key/base url from the
 * stored client (or env) at flush time — by now the user is logged in. Returns true
 * only when the server confirms the write; the SDK returns null (it does not throw)
 * on a failed write, so a falsy result means "keep the file and retry later".
 */
async function uploadRecord(record: PendingRecord): Promise<boolean> {
  const cfg = await loadConfig();
  const client = getClient(cfg, record.clientId);
  const apiKey = client?.api_key ?? process.env.COOLHAND_API_KEY;
  if (!apiKey) {
    return false;
  }
  const baseUrl = client?.base_url ?? DEFAULT_BASE_URL;

  let coolhand: Coolhand;
  try {
    coolhand = new Coolhand({ apiKey, baseUrl, silent: true });
  } catch {
    return false;
  }

  if (record.kind === 'feedback') {
    const result = await coolhand.createFeedback(record.payload as LLMRequestLogFeedback);
    return result !== null && result !== undefined;
  }
  return false;
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

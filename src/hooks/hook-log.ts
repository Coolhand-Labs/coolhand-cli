import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWriteFile } from '../config.js';
import { redact } from '../logger.js';
import { turnsDir } from './turn-state.js';

const MAX_LOG_BYTES = 256 * 1024;
/** What survives a trim: the most recent failures are the ones worth reading. */
const KEEP_LOG_BYTES = 64 * 1024;

/**
 * Append one line to `~/.coolhand/capture-turns/hook.log`. A hook has to stay silent — anything it
 * prints reaches the agent — so this file is the only place its failures can be found. Best-effort
 * and bounded (once it passes 256 KB it is cut back to its last 64 KB); never throws.
 */
export async function logHookEvent(message: string): Promise<void> {
  try {
    const file = path.join(turnsDir(), 'hook.log');
    await fs.mkdir(turnsDir(), { recursive: true, mode: 0o700 });
    try {
      if ((await fs.stat(file)).size > MAX_LOG_BYTES) {
        const tail = (await fs.readFile(file, 'utf8')).slice(-KEEP_LOG_BYTES);
        // Drop the partial first line, then replace the file atomically.
        await atomicWriteFile(file, tail.slice(tail.indexOf('\n') + 1), 0o600);
      }
    } catch {
      // No log yet.
    }
    await fs.appendFile(file, `${new Date().toISOString()} ${redact(message)}\n`, { mode: 0o600 });
  } catch {
    // Nowhere left to report to.
  }
}

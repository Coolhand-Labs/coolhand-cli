import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CliError } from './errors.js';

export interface WriteEnvResult {
  created: boolean;
  replaced: boolean;
  path: string;
}

/**
 * Idempotently sets `key=value` in the env file at `envPath`.
 * Creates the file if missing. Replaces an existing line matching
 * `^\s*KEY\s*=` while preserving comments, whitespace, and other variables.
 */
export async function writeEnvKey(envPath: string, key: string, value: string): Promise<WriteEnvResult> {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
    throw new CliError('WRITE_ENV_FAILED', `Invalid env key: ${key}`);
  }
  const resolved = path.resolve(envPath);
  let existing = '';
  let created = false;
  try {
    existing = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new CliError('WRITE_ENV_FAILED', `Cannot read ${resolved}: ${e.message}`);
    }
    created = true;
  }

  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const matchRegex = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (!replaced && matchRegex.test(line)) {
      out.push(`${key}=${value}`);
      replaced = true;
    } else {
      out.push(line);
    }
  }

  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] === '') {
      out.splice(out.length - 1, 0, `${key}=${value}`);
    } else {
      out.push(`${key}=${value}`);
      out.push('');
    }
  }

  const next = out.join('\n');
  const dir = path.dirname(resolved);
  const tmpPath = path.join(dir, `.${path.basename(resolved)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmpPath, next, { mode: 0o600 });
    await fs.rename(tmpPath, resolved);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw new CliError('WRITE_ENV_FAILED', `Failed to write ${resolved}: ${(err as Error).message}`);
  }

  return { created, replaced, path: resolved };
}

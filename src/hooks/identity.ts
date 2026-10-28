import { execFile } from 'child_process';
import { promises as fs, constants as fsConstants } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { configDir, atomicWriteFile } from '../config.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GIT_TIMEOUT_MS = 2000;

export interface TesterIdentity {
  id: string;
  /** Where `id` came from: an explicit override, the git email, or the anonymous machine id. */
  source: 'env' | 'git' | 'machine';
}

function machineIdPath(): string {
  return path.join(configDir(), 'machine-id');
}

/** A random UUID minted on first use and kept in `~/.coolhand/machine-id`. Identifies a machine, not a person. */
export async function machineId(): Promise<string> {
  try {
    const existing = (await fs.readFile(machineIdPath(), 'utf8')).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Not minted yet.
  }
  const id = randomUUID();
  await fs.mkdir(configDir(), { recursive: true, mode: DIR_MODE });
  try {
    // 'wx': when two first-ever runs race, exactly one creates the file and the other adopts its id.
    await fs.writeFile(machineIdPath(), `${id}\n`, { flag: 'wx', mode: FILE_MODE });
    return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    // The winner creates the file and then writes it; a reader can catch it between the two.
    for (let attempt = 0; attempt < 5; attempt++) {
      const winner = (await fs.readFile(machineIdPath(), 'utf8')).trim();
      if (winner) {
        return winner;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Still empty: a crash left a half-made file. Repair it so the id stops changing on every run.
    await atomicWriteFile(machineIdPath(), `${id}\n`, FILE_MODE);
    return id;
  }
}

/** The machine id, or a throwaway one when the config dir can't be written: attribution is not worth a lost turn. */
async function machineIdentity(): Promise<TesterIdentity> {
  try {
    return { id: await machineId(), source: 'machine' };
  } catch {
    return { id: randomUUID(), source: 'machine' };
  }
}

/**
 * Find an executable on PATH, ignoring empty and relative entries. The session's cwd is an arbitrary,
 * possibly untrusted repository, and Windows searches the working directory (and a `.` PATH entry)
 * when launching a bare command name, so a repo could plant its own `git.exe`. An absolute path
 * resolved here avoids that on every platform.
 */
async function findOnPath(name: string): Promise<string | undefined> {
  const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) {
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

async function gitEmail(cwd?: string): Promise<string | undefined> {
  const git = await findOnPath('git');
  if (!git) {
    return undefined;
  }
  return new Promise((resolve) => {
    try {
      execFile(
        git,
        ['config', 'user.email'],
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          const email = err ? '' : String(stdout).trim();
          resolve(email || undefined);
        }
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Who ran this session, for attributing turns captured with one shared public key.
 *
 * `anonymous` wins over everything: it returns the machine id without consulting the environment or
 * git, so nothing identifying can leave the machine. Otherwise: `COOLHAND_CAPTURE_USER`, then the git
 * email (read from the session's own working directory, so a repo-local `user.email` is honoured),
 * then the machine id. `capture-turn` calls this once per session and keeps the answer in the
 * session's state file.
 */
export async function resolveTesterIdentity(
  opts: { anonymous?: boolean; cwd?: string } = {}
): Promise<TesterIdentity> {
  if (opts.anonymous) {
    return machineIdentity();
  }
  const override = process.env.COOLHAND_CAPTURE_USER?.trim();
  if (override) {
    return { id: override, source: 'env' };
  }
  const email = await gitEmail(opts.cwd);
  if (email) {
    return { id: email, source: 'git' };
  }
  return machineIdentity();
}

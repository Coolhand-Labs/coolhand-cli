import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliError } from '../errors.js';
import type { AgentCommand } from './agent.js';
import { ensurePrivateDir, runsDir } from './definition.js';

export interface SessionRef {
  id: string;
  transcript: string;
}

/** Single-quote a word for /bin/zsh, so a prompt containing `$(...)`, quotes or spaces stays one literal argument. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The body of a `.command` file: Terminal runs it in a new window, in `cwd`, and the agent replaces the shell. */
export function commandFileBody(cwd: string, cmd: AgentCommand): string {
  const line = [cmd.command, ...cmd.args].map(shellQuote).join(' ');
  return `#!/bin/zsh -l\ncd ${shellQuote(cwd)} || exit 1\nexec ${line}\n`;
}

export type RunProgram = (command: string, args: string[]) => Promise<number>;

export const runProgram: RunProgram = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

export interface OpenDeps {
  run?: RunProgram;
  runsDirectory?: string;
  platform?: NodeJS.Platform;
}

function requireMac(deps: OpenDeps): void {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    throw new CliError('SCHEDULE_ERROR', '--open is supported on macOS only');
  }
}

/** Open a new Terminal window running `cmd` in `cwd`. */
export async function openInTerminal(name: string, cwd: string, cmd: AgentCommand, deps: OpenDeps = {}): Promise<string> {
  requireMac(deps);
  const dir = deps.runsDirectory ?? runsDir();
  await ensurePrivateDir(dir);
  const file = path.join(dir, `${name}-${Date.now()}.command`);
  await fs.writeFile(file, commandFileBody(cwd, cmd), { mode: 0o700 });
  const code = await (deps.run ?? runProgram)('open', ['-a', 'Terminal', file]);
  if (code !== 0) {
    throw new CliError('SCHEDULE_ERROR', `Could not open Terminal (open exited ${code})`);
  }
  return file;
}

/** Open a file (the run's transcript) in VS Code. Uses `open -a`, so the `code` shell command need not be installed. */
export async function openInVsCode(file: string, deps: OpenDeps = {}): Promise<void> {
  requireMac(deps);
  const code = await (deps.run ?? runProgram)('open', ['-a', 'Visual Studio Code', file]);
  if (code !== 0) {
    throw new CliError('SCHEDULE_ERROR', `Could not open VS Code (open exited ${code})`);
  }
}

/** The Claude transcript for a session id: Claude files it under a folder named after the working directory. */
export async function findClaudeSession(id: string, home: string = os.homedir()): Promise<SessionRef | undefined> {
  const root = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, `${id}.jsonl`);
    try {
      await fs.access(file);
      return { id, transcript: file };
    } catch {
      // not in this project folder
    }
  }
  return undefined;
}

/** Copilot picks its own session id, so take the newest session folder created since the run started. */
export async function findCopilotSession(since: Date, home: string = os.homedir()): Promise<SessionRef | undefined> {
  const root = path.join(home, '.copilot', 'session-state');
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return undefined;
  }
  let best: { id: string; time: number } | undefined;
  for (const id of names) {
    try {
      const stat = await fs.stat(path.join(root, id, 'events.jsonl'));
      if (stat.mtimeMs >= since.getTime() && (!best || stat.mtimeMs > best.time)) {
        best = { id, time: stat.mtimeMs };
      }
    } catch {
      // not a session folder
    }
  }
  return best ? { id: best.id, transcript: path.join(root, best.id, 'events.jsonl') } : undefined;
}

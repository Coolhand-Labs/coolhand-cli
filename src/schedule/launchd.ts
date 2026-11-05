import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFile } from '../config.js';
import { CliError } from '../errors.js';
import type { Cadence, ScheduleDef } from './definition.js';

export const LABEL_PREFIX = 'ai.coolhand.schedule.';

export function launchdLabel(name: string): string {
  return `${LABEL_PREFIX}${name}`;
}

export function launchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

export function plistPath(name: string, dir: string = launchAgentsDir()): string {
  return path.join(dir, `${launchdLabel(name)}.plist`);
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function calendarInterval(cadence: Cadence): string {
  const entries: Array<[string, number]> =
    cadence.kind === 'weekly'
      ? [['Weekday', cadence.weekday], ['Hour', cadence.hour], ['Minute', cadence.minute]]
      : [['Hour', cadence.hour], ['Minute', cadence.minute]];
  return entries.map(([key, value]) => `    <key>${key}</key><integer>${value}</integer>`).join('\n');
}

export interface PlistInput {
  def: ScheduleDef;
  /** The command launchd runs: an absolute node, the CLI entry point, and `schedule run NAME`. */
  program: string[];
  logPath: string;
  env: Record<string, string>;
}

/** The launchd job. It holds no secrets: credentials come from the run-time environment or the schedule's env file. */
export function buildPlist({ def, program, logPath, env }: PlistInput): string {
  const args = program.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  const vars = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(launchdLabel(def.name))}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${calendarInterval(def.cadence)}
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(def.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export type RunLaunchctl = (args: string[]) => Promise<{ code: number; output: string }>;

export const runLaunchctl: RunLaunchctl = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export interface LaunchdDeps {
  launchctl?: RunLaunchctl;
  agentsDir?: string;
}

/** Write the plist and load it. An existing plist for the same name is replaced only with `force`. */
export async function installJob(input: PlistInput, force: boolean, deps: LaunchdDeps = {}): Promise<string> {
  const launchctl = deps.launchctl ?? runLaunchctl;
  const dir = deps.agentsDir ?? launchAgentsDir();
  const file = plistPath(input.def.name, dir);
  let exists = true;
  try {
    await fs.access(file);
  } catch {
    exists = false;
  }
  if (exists && !force) {
    throw new CliError('INVALID_ARGS', `${file} already exists. Remove it with \`coolhand schedule remove ${input.def.name}\` or pass --force`);
  }
  await fs.mkdir(dir, { recursive: true });
  if (exists) {
    await launchctl(['bootout', `${domain()}/${launchdLabel(input.def.name)}`]).catch(() => undefined);
  }
  await atomicWriteFile(file, buildPlist(input), 0o644);
  const result = await launchctl(['bootstrap', domain(), file]);
  if (result.code !== 0) {
    await fs.rm(file, { force: true });
    throw new CliError('SCHEDULE_ERROR', `launchctl bootstrap failed: ${result.output || `exit ${result.code}`}`);
  }
  return file;
}

/** Unload the job and delete its plist. Missing pieces are not errors: removing twice is fine. */
export async function removeJob(name: string, deps: LaunchdDeps = {}): Promise<boolean> {
  const launchctl = deps.launchctl ?? runLaunchctl;
  const file = plistPath(name, deps.agentsDir);
  await launchctl(['bootout', `${domain()}/${launchdLabel(name)}`]).catch(() => undefined);
  try {
    await fs.rm(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new CliError('SCHEDULE_ERROR', `Failed to delete ${file}: ${(err as Error).message}`);
  }
}

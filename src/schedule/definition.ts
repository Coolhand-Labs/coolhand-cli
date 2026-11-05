import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWriteFile, configDir } from '../config.js';
import { CliError } from '../errors.js';

export type ScheduleAgent = 'claude' | 'copilot';
export type ScheduleMode = 'headless' | 'interactive';
export type OpenTarget = 'none' | 'claude' | 'copilot' | 'codex' | 'vscode';

export const SCHEDULE_AGENTS: readonly ScheduleAgent[] = ['claude', 'copilot'];
export const SCHEDULE_MODES: readonly ScheduleMode[] = ['headless', 'interactive'];
export const OPEN_TARGETS: readonly OpenTarget[] = ['none', 'claude', 'copilot', 'codex', 'vscode'];

export type Cadence =
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'daily'; hour: number; minute: number };

export interface LastRun {
  at: string;
  exit_code: number | null;
  session_id?: string;
}

export interface ScheduleDef {
  name: string;
  agent: ScheduleAgent;
  prompt: string;
  mode: ScheduleMode;
  open: OpenTarget;
  cadence: Cadence;
  /** Absolute directory the agent runs in. */
  cwd: string;
  /** Tool permission rules for the unattended run, in the agent's own syntax. */
  allow: string[];
  max_budget_usd?: number;
  max_ai_credits?: number;
  /** Path to a KEY=VALUE file read at run time, never copied into the scheduler entry. */
  env_file?: string;
  /** PATH the scheduled run uses: a scheduler starts with almost none, and the agent's launcher needs `node`. */
  path: string;
  /** The agent executable found on PATH when the schedule was added, shown so the user can see which install will run. */
  agent_bin?: string;
  created_at: string;
  last_run?: LastRun;
}

interface ScheduleFile {
  version: 1;
  schedules: Record<string, ScheduleDef>;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function validateName(name: string | undefined): string {
  if (!name || !NAME_RE.test(name)) {
    throw new CliError(
      'INVALID_ARGS',
      'A schedule name must be 1-40 characters: lowercase letters, digits and hyphens, starting with a letter or digit'
    );
  }
  return name;
}

function parseTime(text: string, flag: string): { hour: number; minute: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) {
    throw new CliError('INVALID_ARGS', `${flag} needs a 24-hour time such as 09:00, got "${text}"`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** `--weekly mon@09:00` or `--daily 09:00`, exactly one of them. */
export function parseCadence(weekly: string | undefined, daily: string | undefined): Cadence {
  if ((weekly === undefined) === (daily === undefined)) {
    throw new CliError('INVALID_ARGS', 'schedule add needs exactly one of --weekly DAY@HH:MM or --daily HH:MM');
  }
  if (daily !== undefined) {
    return { kind: 'daily', ...parseTime(daily, '--daily') };
  }
  const [day, time, ...extra] = (weekly as string).split('@');
  const weekday = WEEKDAYS.indexOf((day ?? '').toLowerCase());
  if (weekday < 0 || time === undefined || extra.length > 0) {
    throw new CliError('INVALID_ARGS', `--weekly needs DAY@HH:MM with DAY one of ${WEEKDAYS.join(', ')}, for example mon@09:00`);
  }
  return { kind: 'weekly', weekday, ...parseTime(time, '--weekly') };
}

export function describeCadence(cadence: Cadence): string {
  const time = `${String(cadence.hour).padStart(2, '0')}:${String(cadence.minute).padStart(2, '0')}`;
  return cadence.kind === 'daily' ? `every day at ${time}` : `every ${WEEKDAY_LABELS[cadence.weekday]} at ${time}`;
}

export function schedulesPath(): string {
  return path.join(configDir(), 'schedules.json');
}

export function runsDir(): string {
  return path.join(configDir(), 'schedule-runs');
}

export function logsDir(): string {
  return path.join(configDir(), 'schedule-logs');
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function loadSchedules(): Promise<Record<string, ScheduleDef>> {
  const file = schedulesPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new CliError('CONFIG_READ_FAILED', `Failed to read ${file}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScheduleFile>;
    return parsed.schedules && typeof parsed.schedules === 'object' ? parsed.schedules : {};
  } catch (err) {
    throw new CliError('CONFIG_READ_FAILED', `${file} is not valid JSON: ${(err as Error).message}`);
  }
}

export async function saveSchedules(schedules: Record<string, ScheduleDef>): Promise<void> {
  const file = schedulesPath();
  await ensurePrivateDir(path.dirname(file));
  const body: ScheduleFile = { version: 1, schedules };
  await atomicWriteFile(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Own properties only, so a name like `constructor` can never resolve to an inherited member. */
export function findSchedule(schedules: Record<string, ScheduleDef>, name: string): ScheduleDef | undefined {
  return Object.prototype.hasOwnProperty.call(schedules, name) ? schedules[name] : undefined;
}

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CliError, ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { confirm, isInteractive } from '../prompt.js';
import { headlessCommand, interactiveCommand, checkOpen, resumeCommand, type AgentCommand } from '../schedule/agent.js';
import {
  OPEN_TARGETS,
  SCHEDULE_AGENTS,
  SCHEDULE_MODES,
  describeCadence,
  ensurePrivateDir,
  findSchedule,
  loadSchedules,
  logsDir,
  parseCadence,
  saveSchedules,
  validateName,
  type OpenTarget,
  type ScheduleAgent,
  type ScheduleDef,
  type ScheduleMode,
} from '../schedule/definition.js';
import { buildPlist, installJob, plistPath, removeJob, type LaunchdDeps } from '../schedule/launchd.js';
import {
  findClaudeSession,
  findCopilotSession,
  openInTerminal,
  openInVsCode,
  type OpenDeps,
  type SessionRef,
} from '../schedule/open.js';
import type { ScheduleOptions } from '../types.js';

const MAX_PROMPT_LENGTH = 4000;
const MIN_COPILOT_CREDITS = 30;
/** Directories a scheduled run always gets, after the agent's and node's own. */
const BASE_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export interface SpawnResult {
  code: number;
}

export interface ScheduleDeps extends LaunchdDeps, OpenDeps {
  /** Run the agent for a headless schedule, with output going to the scheduler's log. */
  spawnAgent?: (cmd: AgentCommand, cwd: string, env: NodeJS.ProcessEnv) => Promise<SpawnResult>;
  /** What the scheduler runs: an absolute node, the CLI entry point, then `schedule run NAME`. */
  program?: (name: string) => string[];
  /** Absolute path of an executable on `PATH`, or undefined. */
  which?: (command: string) => Promise<string | undefined>;
  confirmFn?: (question: string) => Promise<boolean>;
  interactive?: () => boolean;
  now?: () => Date;
  uuid?: () => string;
  logPath?: (name: string) => string;
  /** Home directory the agents' session folders are looked up in. */
  home?: string;
}

const spawnAgent: NonNullable<ScheduleDeps['spawnAgent']> = (cmd, cwd, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd.command, cmd.args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });

async function which(command: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const file = path.join(dir, command);
    try {
      await fs.access(file, fs.constants.X_OK);
      return file;
    } catch {
      // try the next directory
    }
  }
  return undefined;
}

/**
 * The node that runs this CLI, by the path a package manager keeps stable. `process.execPath` is the versioned file
 * (e.g. Homebrew's Cellar/node@22/22.22.3), which disappears on the next upgrade and would silently break the job.
 */
async function stableNode(find: (command: string) => Promise<string | undefined>): Promise<string> {
  const onPath = await find('node');
  if (onPath) {
    try {
      if ((await fs.realpath(onPath)) === (await fs.realpath(process.execPath))) {
        return onPath;
      }
    } catch {
      // fall through to the exact binary running now
    }
  }
  return process.execPath;
}

async function defaultProgram(name: string, nodeBin: string): Promise<string[]> {
  const entry = await fs.realpath(process.argv[1] ?? '');
  if (entry.split(path.sep).includes('_npx')) {
    throw new CliError(
      'SCHEDULE_ERROR',
      'This copy of coolhand-cli is running from the npx cache, which is cleaned up. Install it first: npm i -g coolhand-cli'
    );
  }
  return [nodeBin, entry, 'schedule', 'run', name];
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback?: T): T {
  const chosen = value ?? fallback;
  if (chosen === undefined || !allowed.includes(chosen as T)) {
    throw new CliError('INVALID_ARGS', `${flag} must be one of: ${allowed.join(', ')}`);
  }
  return chosen as T;
}

function parseNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError('INVALID_ARGS', `${flag} must be a positive number`);
  }
  return n;
}

function buildPrompt(opts: ScheduleOptions): string {
  if ((opts.prompt === undefined) === (opts.skill === undefined)) {
    throw new CliError('INVALID_ARGS', 'schedule add needs exactly one of --prompt TEXT or --skill NAME');
  }
  const prompt = opts.skill !== undefined ? `/${opts.skill}` : (opts.prompt as string);
  if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    throw new CliError('INVALID_ARGS', `The prompt must be 1-${MAX_PROMPT_LENGTH} characters`);
  }
  if (prompt.startsWith('-')) {
    // It would be read as a flag by the agent's own argument parser.
    throw new CliError('INVALID_ARGS', 'The prompt must not start with "-"');
  }
  if (opts.skill !== undefined && /\s/.test(opts.skill)) {
    throw new CliError('INVALID_ARGS', '--skill takes a skill name, for example acme-weekly-review or acme:acme-weekly-review. Put arguments in --prompt');
  }
  return prompt;
}

/** `KEY=VALUE` lines, `#` comments, an optional `export `, and one pair of matching quotes around the value. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

async function readEnvFile(file: string): Promise<Record<string, string>> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    throw new CliError('SCHEDULE_ERROR', `Cannot read env file ${file}: ${(err as Error).message}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new CliError('SCHEDULE_ERROR', `${file} is readable by other users. Run: chmod 600 ${file}`);
  }
  return parseEnvFile(await fs.readFile(file, 'utf8'));
}

async function pathFor(
  def: Pick<ScheduleDef, 'agent' | 'open'>,
  nodeBin: string,
  find: (command: string) => Promise<string | undefined>
): Promise<{ path: string; agentBin: string }> {
  const wanted = [def.agent, ...(def.open === 'codex' ? ['codex'] : [])];
  const dirs: string[] = [];
  let agentBin = '';
  for (const command of wanted) {
    const found = await find(command);
    if (!found) {
      throw new CliError('SCHEDULE_ERROR', `\`${command}\` was not found on PATH. Install it first, then run this again`);
    }
    agentBin ||= found;
    dirs.push(path.dirname(found));
  }
  // The agent's launcher starts with `#!/usr/bin/env node`, and a scheduler's PATH rarely has node on it.
  dirs.push(path.dirname(nodeBin), ...BASE_PATH);
  return { path: [...new Set(dirs)].join(path.delimiter), agentBin };
}

function describe(def: ScheduleDef): string[] {
  const lines = [
    `Schedule:  ${def.name} (${describeCadence(def.cadence)})`,
    `Agent:     ${def.agent}${def.agent_bin ? ` (${def.agent_bin})` : ''}, ${def.mode === 'headless' ? 'unattended' : 'opens an interactive session'}`,
    `Prompt:    ${def.prompt.length > 100 ? `${def.prompt.slice(0, 100)}…` : def.prompt}`,
    `Directory: ${def.cwd}`,
  ];
  if (def.mode === 'headless') {
    lines.push(`Tools:     ${def.allow.length > 0 ? def.allow.join(', ') : 'none allowed (any tool the prompt needs will be denied)'}`);
  }
  lines.push(`Then open: ${def.open === 'none' ? 'nothing' : def.open}`);
  return lines;
}

function cloudInstructions(def: Pick<ScheduleDef, 'prompt' | 'cadence'>): string {
  return `/schedule ${describeCadence(def.cadence)}: ${def.prompt}`;
}

async function add(opts: ScheduleOptions, deps: ScheduleDeps): Promise<number> {
  const name = validateName(opts.name);
  const backend = oneOf(opts.backend, ['launchd', 'cloud'] as const, '--backend', 'launchd');
  const agent = oneOf<ScheduleAgent>(opts.agent, SCHEDULE_AGENTS, '--agent');
  const prompt = buildPrompt(opts);
  const cadence = parseCadence(opts.weekly, opts.daily);

  if (backend === 'cloud') {
    return addCloud(name, agent, prompt, cadence, opts, deps);
  }
  if ((deps.platform ?? process.platform) !== 'darwin') {
    throw new CliError('SCHEDULE_ERROR', 'The launchd backend works on macOS only. On this system use --backend cloud, or your own scheduler');
  }

  const mode = oneOf<ScheduleMode>(opts.mode, SCHEDULE_MODES, '--mode', 'headless');
  const open = oneOf<OpenTarget>(opts.open, OPEN_TARGETS, '--open', 'none');
  const problem = checkOpen(mode, agent, open);
  if (problem) {
    throw new CliError('INVALID_ARGS', problem);
  }

  const maxBudget = parseNumber(opts.maxBudgetUsd, '--max-budget-usd');
  const maxCredits = parseNumber(opts.maxAiCredits, '--max-ai-credits');
  if (maxBudget !== undefined && agent !== 'claude') {
    throw new CliError('INVALID_ARGS', '--max-budget-usd applies to --agent claude. For copilot use --max-ai-credits');
  }
  if (maxCredits !== undefined && agent !== 'copilot') {
    throw new CliError('INVALID_ARGS', '--max-ai-credits applies to --agent copilot. For claude use --max-budget-usd');
  }
  if (maxCredits !== undefined && maxCredits < MIN_COPILOT_CREDITS) {
    throw new CliError('INVALID_ARGS', `--max-ai-credits must be at least ${MIN_COPILOT_CREDITS}`);
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd());
  try {
    if (!(await fs.stat(cwd)).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new CliError('INVALID_ARGS', `--cwd ${cwd} is not a directory`);
  }
  const envFile = opts.envFile !== undefined ? path.resolve(opts.envFile) : undefined;
  if (envFile) {
    await readEnvFile(envFile);
  }

  const find = deps.which ?? which;
  const nodeBin = await stableNode(find);
  const resolved = await pathFor({ agent, open }, nodeBin, find);
  const def: ScheduleDef = {
    name,
    agent,
    prompt,
    mode,
    open,
    cadence,
    cwd,
    allow: opts.allow,
    ...(maxBudget !== undefined ? { max_budget_usd: maxBudget } : {}),
    ...(maxCredits !== undefined ? { max_ai_credits: maxCredits } : {}),
    ...(envFile ? { env_file: envFile } : {}),
    path: resolved.path,
    agent_bin: resolved.agentBin,
    created_at: (deps.now ?? (() => new Date()))().toISOString(),
  };

  const program = deps.program ? deps.program(name) : await defaultProgram(name, nodeBin);
  const logPath = (deps.logPath ?? ((n: string) => path.join(logsDir(), `${n}.log`)))(name);
  const env: Record<string, string> = { PATH: def.path, HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', LOGNAME: process.env.USER ?? '' };
  if (process.env.COOLHAND_CONFIG_DIR) {
    // The scheduled run must read the same schedules.json this command just wrote.
    env.COOLHAND_CONFIG_DIR = process.env.COOLHAND_CONFIG_DIR;
  }
  const plist = { def, program, logPath, env };
  const file = plistPath(name, deps.agentsDir);

  if (opts.dryRun) {
    if (opts.json) {
      logger.json({ dry_run: true, schedule: def, plist_path: file, plist: buildPlist(plist) });
    } else {
      logger.info(`${describe(def).join('\n')}\n\nWould write ${file}:\n\n${buildPlist(plist)}`);
    }
    return ExitCode.OK;
  }

  const schedules = await loadSchedules();
  if (findSchedule(schedules, name) && !opts.force) {
    throw new CliError('INVALID_ARGS', `A schedule named "${name}" already exists. Remove it first or pass --force`);
  }

  if (!opts.yes) {
    const interactive = (deps.interactive ?? isInteractive)();
    if (!interactive) {
      throw new CliError('INVALID_ARGS', 'schedule add installs a launchd job. Run it in a terminal to confirm, or pass --yes');
    }
    logger.info(`${describe(def).join('\n')}\n\nThis will write ${file} and load it with launchctl. Remove it any time with: coolhand schedule remove ${name}`);
    if (!(await (deps.confirmFn ?? confirm)('Install this schedule?'))) {
      logger.info('Not installed.');
      return ExitCode.ABORTED;
    }
  }

  await ensurePrivateDir(path.dirname(logPath));
  await installJob(plist, opts.force === true, deps);
  try {
    await saveSchedules({ ...schedules, [name]: def });
  } catch (err) {
    await removeJob(name, deps).catch(() => undefined);
    throw err;
  }

  if (opts.json) {
    logger.json({ installed: true, schedule: def, plist_path: file, log_path: logPath });
  } else {
    logger.info(`Installed ${name}: ${describeCadence(cadence)}. Logs: ${logPath}`);
    if (mode === 'headless' && def.allow.length === 0) {
      logger.warn('No --allow rules were given, so an unattended run will be denied any tool it needs. Reinstall with --force and --allow to grant them.');
    }
    logger.info(`Run it now to test: coolhand schedule run ${name}`);
  }
  return ExitCode.OK;
}

/** Claude Code's own scheduled runs. No CLI can create one, so this prints the line to give Claude, or starts a session with it. */
async function addCloud(
  name: string,
  agent: ScheduleAgent,
  prompt: string,
  cadence: ScheduleDef['cadence'],
  opts: ScheduleOptions,
  deps: ScheduleDeps
): Promise<number> {
  if (agent !== 'claude') {
    throw new CliError('INVALID_ARGS', '--backend cloud is Claude Code\'s scheduled runs, so it needs --agent claude');
  }
  if (opts.mode !== undefined || opts.open !== undefined || opts.allow.length > 0 || opts.envFile !== undefined) {
    throw new CliError('INVALID_ARGS', '--backend cloud runs on Anthropic\'s side: --mode, --open, --allow and --env-file do not apply');
  }
  const instruction = cloudInstructions({ prompt, cadence });
  if (opts.launch) {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    await openInTerminal(name, cwd, interactiveCommand('claude', instruction), deps);
  }
  if (opts.json) {
    logger.json({ backend: 'cloud', installed: false, instruction, launched: opts.launch === true });
  } else {
    logger.info(
      [
        opts.launch ? 'Started a Claude Code session in Terminal with this message:' : 'Nothing was installed on this machine. Give Claude Code this message in a session:',
        '',
        `  ${instruction}`,
        '',
        'Claude creates the schedule on its own side and asks you to confirm it. The run happens in the cloud, so it cannot read local files, and it is not captured by a local hook.',
        ...(opts.launch ? [] : ['Pass --launch to open that session for you.']),
      ].join('\n')
    );
  }
  return ExitCode.OK;
}

async function list(opts: ScheduleOptions): Promise<number> {
  const schedules = Object.values(await loadSchedules());
  if (opts.json) {
    logger.json({ schedules });
    return ExitCode.OK;
  }
  if (schedules.length === 0) {
    logger.info('No schedules. Add one with: coolhand schedule add NAME --agent claude --skill SKILL --weekly mon@09:00 --yes');
    return ExitCode.OK;
  }
  for (const s of schedules) {
    const last = s.last_run ? `last run ${s.last_run.at} (exit ${s.last_run.exit_code ?? '?'})` : 'never run';
    logger.info(`${s.name}  ${describeCadence(s.cadence)}  ${s.agent}/${s.mode}  open: ${s.open}  ${last}`);
  }
  return ExitCode.OK;
}

async function remove(opts: ScheduleOptions, deps: ScheduleDeps): Promise<number> {
  const name = validateName(opts.name);
  const schedules = await loadSchedules();
  const known = findSchedule(schedules, name) !== undefined;
  const removedFile = await removeJob(name, deps);
  if (!known && !removedFile) {
    throw new CliError('SCHEDULE_ERROR', `No schedule named "${name}"`);
  }
  if (known) {
    const rest = { ...schedules };
    delete rest[name];
    await saveSchedules(rest);
  }
  if (opts.json) {
    logger.json({ removed: name });
  } else {
    logger.info(`Removed ${name}.`);
  }
  return ExitCode.OK;
}

async function openAfterRun(def: ScheduleDef, session: SessionRef | undefined, deps: ScheduleDeps): Promise<void> {
  if (def.open === 'none') {
    return;
  }
  if (!session) {
    logger.warn(`The ${def.agent} session for this run could not be found, so nothing was opened.`);
    return;
  }
  if (def.open === 'vscode') {
    await openInVsCode(session.transcript, deps);
    return;
  }
  await openInTerminal(def.name, def.cwd, resumeCommand(def.agent, session.id), deps);
}

async function recordRun(name: string, last: NonNullable<ScheduleDef['last_run']>): Promise<void> {
  const schedules = await loadSchedules();
  const current = findSchedule(schedules, name);
  if (current) {
    await saveSchedules({ ...schedules, [name]: { ...current, last_run: last } });
  }
}

async function runNow(opts: ScheduleOptions, deps: ScheduleDeps): Promise<number> {
  const name = validateName(opts.name);
  const def = findSchedule(await loadSchedules(), name);
  if (!def) {
    throw new CliError('SCHEDULE_ERROR', `No schedule named "${name}"`);
  }
  const now = deps.now ?? (() => new Date());

  if (def.mode === 'interactive') {
    if (def.open === 'none' || def.open === 'vscode') {
      throw new CliError('SCHEDULE_ERROR', `Schedule "${name}" is interactive but has --open ${def.open}`);
    }
    await openInTerminal(name, def.cwd, interactiveCommand(def.open, def.prompt), deps);
    await recordRun(name, { at: now().toISOString(), exit_code: null });
    return ExitCode.OK;
  }

  const fileEnv = def.env_file ? await readEnvFile(def.env_file) : {};
  const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnv, PATH: def.path };
  const sessionId = def.agent === 'claude' ? (deps.uuid ?? randomUUID)() : undefined;
  const startedAt = now();
  let result: SpawnResult;
  try {
    result = await (deps.spawnAgent ?? spawnAgent)(headlessCommand(def, sessionId), def.cwd, env);
  } catch (err) {
    await recordRun(name, { at: startedAt.toISOString(), exit_code: null });
    throw new CliError('SCHEDULE_ERROR', `Could not start ${def.agent}: ${(err as Error).message}`);
  }

  const session =
    def.agent === 'claude' && sessionId ? await findClaudeSession(sessionId, deps.home) : def.agent === 'copilot' ? await findCopilotSession(startedAt, deps.home) : undefined;
  await recordRun(name, { at: startedAt.toISOString(), exit_code: result.code, ...(session ? { session_id: session.id } : {}) });
  logger.info(`${name}: ${def.agent} exited ${result.code}${session ? `, session ${session.id}` : ''}.`);
  await openAfterRun(def, session, deps);
  return result.code === 0 ? ExitCode.OK : ExitCode.USER_ERROR;
}

export async function run(opts: ScheduleOptions, deps: ScheduleDeps = {}): Promise<number> {
  switch (opts.action) {
    case 'add':
      return add(opts, deps);
    case 'list':
      return list(opts);
    case 'remove':
      return remove(opts, deps);
    case 'run':
      return runNow(opts, deps);
    default:
      throw new CliError('INVALID_ARGS', 'schedule needs an action: add, list, remove or run');
  }
}

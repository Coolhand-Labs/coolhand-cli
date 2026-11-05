import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run, type ScheduleDeps } from '../../src/commands/schedule.js';
import { CliError, ExitCode } from '../../src/errors.js';
import { logger } from '../../src/logger.js';
import { loadSchedules, saveSchedules } from '../../src/schedule/definition.js';
import type { ScheduleOptions } from '../../src/types.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

const opts = (over: Partial<ScheduleOptions> = {}): ScheduleOptions => ({ allow: [], ...over });

describe('schedule command', () => {
  let home: TmpHome;
  let agentsDir: string;
  let sessionHome: string;
  let launchctl: jest.Mock;
  let openRun: jest.Mock;
  let spawnAgent: jest.Mock;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let jsonSpy: jest.SpyInstance;

  const deps = (over: Partial<ScheduleDeps> = {}): ScheduleDeps => ({
    launchctl,
    agentsDir,
    run: openRun,
    runsDirectory: path.join(home.dir, 'runs'),
    platform: 'darwin',
    spawnAgent,
    program: (name) => ['/opt/node', '/opt/coolhand/bin.js', 'schedule', 'run', name],
    which: async (command) => `/opt/tools/bin/${command}`,
    interactive: () => false,
    logPath: (name) => path.join(home.dir, 'logs', `${name}.log`),
    home: sessionHome,
    now: () => new Date('2026-11-05T09:00:00.000Z'),
    uuid: () => '11111111-2222-4333-8444-555555555555',
    ...over,
  });

  const add = (over: Partial<ScheduleOptions> = {}, d: Partial<ScheduleDeps> = {}) =>
    run(opts({ action: 'add', name: 'weekly-review', agent: 'claude', skill: 'acme:acme-weekly-review', weekly: 'mon@09:00', yes: true, cwd: home.dir, ...over }), deps(d));

  beforeEach(async () => {
    home = await createTmpHome();
    agentsDir = path.join(home.dir, 'LaunchAgents');
    sessionHome = path.join(home.dir, 'home');
    launchctl = jest.fn().mockResolvedValue({ code: 0, output: '' });
    openRun = jest.fn().mockResolvedValue(0);
    spawnAgent = jest.fn().mockResolvedValue({ code: 0 });
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
  });

  afterEach(async () => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    jsonSpy.mockRestore();
    await home.cleanup();
  });

  describe('add (launchd)', () => {
    it('stores the schedule, writes the plist and loads it', async () => {
      expect(await add({ allow: ['Read'] })).toBe(ExitCode.OK);
      const stored = (await loadSchedules())['weekly-review'];
      expect(stored).toMatchObject({
        agent: 'claude',
        prompt: '/acme:acme-weekly-review',
        mode: 'headless',
        open: 'none',
        cadence: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 },
        allow: ['Read'],
      });
      expect(stored.path).toContain('/opt/tools/bin');
      const plist = await fs.readFile(path.join(agentsDir, 'ai.coolhand.schedule.weekly-review.plist'), 'utf8');
      expect(plist).toContain('<key>Weekday</key><integer>1</integer>');
      expect(launchctl).toHaveBeenCalledWith(['bootstrap', expect.stringMatching(/^gui\/\d+$/), expect.stringContaining('weekly-review.plist')]);
    });

    it('stores the file with owner-only permissions', async () => {
      await add();
      const mode = (await fs.stat(path.join(home.dir, 'schedules.json'))).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('writes nothing on --dry-run', async () => {
      expect(await add({ dryRun: true, yes: false })).toBe(ExitCode.OK);
      expect(await loadSchedules()).toEqual({});
      expect(launchctl).not.toHaveBeenCalled();
      await expect(fs.access(agentsDir)).rejects.toThrow();
    });

    it('refuses without --yes when there is no terminal', async () => {
      await expect(add({ yes: false })).rejects.toThrow('pass --yes');
      expect(launchctl).not.toHaveBeenCalled();
    });

    it('asks for confirmation in a terminal and installs nothing on "no"', async () => {
      const confirmFn = jest.fn().mockResolvedValue(false);
      expect(await add({ yes: false }, { interactive: () => true, confirmFn })).toBe(ExitCode.ABORTED);
      expect(confirmFn).toHaveBeenCalled();
      expect(await loadSchedules()).toEqual({});
    });

    it('refuses to overwrite a schedule, but replaces it with --force', async () => {
      await add();
      await expect(add()).rejects.toThrow('already exists');
      launchctl.mockClear();
      await add({ force: true, prompt: undefined, skill: 'other' });
      expect((await loadSchedules())['weekly-review'].prompt).toBe('/other');
      expect(launchctl.mock.calls.map((c) => c[0][0])).toEqual(['bootout', 'bootstrap']);
    });

    it('rolls back the plist when launchctl refuses it', async () => {
      launchctl.mockResolvedValueOnce({ code: 5, output: 'Bootstrap failed: 5' });
      await expect(add()).rejects.toThrow('launchctl bootstrap failed');
      expect(await loadSchedules()).toEqual({});
      expect(await fs.readdir(agentsDir)).toEqual([]);
    });

    it('works on macOS only', async () => {
      await expect(add({}, { platform: 'linux' })).rejects.toThrow('macOS only');
    });

    it('needs the agent on PATH', async () => {
      await expect(add({}, { which: async () => undefined })).rejects.toThrow('`claude` was not found on PATH');
    });

    it('warns when an unattended run has no tool rules', async () => {
      await add();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No --allow rules'));
    });

    it.each([
      [{ open: 'codex' }, 'Codex cannot continue a claude session'],
      [{ agent: 'copilot', open: 'claude' }, 'cannot continue a copilot session'],
      [{ mode: 'interactive', open: 'vscode' }, 'cannot open VS Code'],
      [{ mode: 'interactive' }, 'needs --open'],
      [{ maxAiCredits: '50' }, 'applies to --agent copilot'],
      [{ agent: 'copilot', maxBudgetUsd: '2' }, 'applies to --agent claude'],
      [{ agent: 'copilot', maxAiCredits: '10' }, 'at least 30'],
      [{ skill: undefined, prompt: undefined }, 'exactly one of --prompt'],
      [{ skill: undefined, prompt: '--help' }, 'must not start with "-"'],
      [{ skill: 'two words' }, 'takes a skill name'],
      [{ cwd: '/definitely/not/here' }, 'is not a directory'],
      [{ weekly: undefined }, 'exactly one of --weekly'],
      [{ name: 'Bad Name' }, 'schedule name'],
    ] as Array<[Partial<ScheduleOptions>, string]>)('rejects %j', async (over, message) => {
      await expect(add(over)).rejects.toThrow(message);
      expect(launchctl).not.toHaveBeenCalled();
    });

    it('rejects an env file other users can read', async () => {
      const file = path.join(home.dir, 'tokens.env');
      await fs.writeFile(file, 'COPILOT_GITHUB_TOKEN=x\n', { mode: 0o644 });
      await fs.chmod(file, 0o644);
      await expect(add({ envFile: file })).rejects.toThrow('chmod 600');
    });
  });

  describe('add (cloud)', () => {
    it('installs nothing and prints the message for Claude', async () => {
      expect(await add({ backend: 'cloud', yes: false })).toBe(ExitCode.OK);
      expect(launchctl).not.toHaveBeenCalled();
      expect(await loadSchedules()).toEqual({});
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('/schedule every Monday at 09:00: /acme:acme-weekly-review'));
    });

    it('opens a Terminal session with --launch', async () => {
      await add({ backend: 'cloud', launch: true });
      expect(openRun).toHaveBeenCalledWith('open', ['-a', 'Terminal', expect.stringContaining('weekly-review')]);
      const file = openRun.mock.calls[0][1][2];
      expect(await fs.readFile(file, 'utf8')).toContain("exec 'claude' '/schedule every Monday at 09:00: /acme:acme-weekly-review'");
    });

    it.each([
      [{ agent: 'copilot' }, 'needs --agent claude'],
      [{ open: 'vscode' }, 'do not apply'],
      [{ allow: ['Read'] }, 'do not apply'],
    ] as Array<[Partial<ScheduleOptions>, string]>)('rejects %j', async (over, message) => {
      await expect(add({ backend: 'cloud', ...over })).rejects.toThrow(message);
    });
  });

  describe('list and remove', () => {
    it('lists schedules as JSON', async () => {
      await add();
      await run(opts({ action: 'list', json: true }), deps());
      expect(jsonSpy).toHaveBeenCalledWith({ schedules: [expect.objectContaining({ name: 'weekly-review' })] });
    });

    it('says so when there are none', async () => {
      await run(opts({ action: 'list' }), deps());
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No schedules'));
    });

    it('unloads the job, deletes the plist and forgets the schedule', async () => {
      await add();
      launchctl.mockClear();
      expect(await run(opts({ action: 'remove', name: 'weekly-review' }), deps())).toBe(ExitCode.OK);
      expect(launchctl).toHaveBeenCalledWith(['bootout', expect.stringContaining('ai.coolhand.schedule.weekly-review')]);
      expect(await loadSchedules()).toEqual({});
      expect(await fs.readdir(agentsDir)).toEqual([]);
    });

    it('errors on an unknown name', async () => {
      await expect(run(opts({ action: 'remove', name: 'nope' }), deps())).rejects.toBeInstanceOf(CliError);
    });
  });

  describe('run', () => {
    const claudeTranscript = async () => {
      const dir = path.join(sessionHome, '.claude', 'projects', '-tmp-work');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, '11111111-2222-4333-8444-555555555555.jsonl');
      await fs.writeFile(file, '{}\n');
      return file;
    };

    it('runs claude headless with a session id and the stored PATH, and records the run', async () => {
      await add({ allow: ['Read'] });
      await claudeTranscript();
      expect(await run(opts({ action: 'run', name: 'weekly-review' }), deps())).toBe(ExitCode.OK);
      const [cmd, cwd, env] = spawnAgent.mock.calls[0];
      expect(cmd.command).toBe('claude');
      expect(cmd.args).toEqual(['-p', '/acme:acme-weekly-review', '--session-id', '11111111-2222-4333-8444-555555555555', '--allowedTools', 'Read']);
      expect(cwd).toBe(home.dir);
      expect(env.PATH).toContain('/opt/tools/bin');
      expect((await loadSchedules())['weekly-review'].last_run).toEqual({
        at: '2026-11-05T09:00:00.000Z',
        exit_code: 0,
        session_id: '11111111-2222-4333-8444-555555555555',
      });
      expect(openRun).not.toHaveBeenCalled();
    });

    it('reopens the finished session with claude --resume in Terminal', async () => {
      await add({ open: 'claude' });
      await claudeTranscript();
      await run(opts({ action: 'run', name: 'weekly-review' }), deps());
      const file = openRun.mock.calls[0][1][2];
      expect(openRun.mock.calls[0][1].slice(0, 2)).toEqual(['-a', 'Terminal']);
      expect(await fs.readFile(file, 'utf8')).toContain("exec 'claude' '--resume' '11111111-2222-4333-8444-555555555555'");
    });

    it('opens the transcript in VS Code', async () => {
      await add({ open: 'vscode' });
      const transcript = await claudeTranscript();
      await run(opts({ action: 'run', name: 'weekly-review' }), deps());
      expect(openRun).toHaveBeenCalledWith('open', ['-a', 'Visual Studio Code', transcript]);
    });

    it('warns instead of failing when the session cannot be found', async () => {
      await add({ open: 'vscode' });
      await run(opts({ action: 'run', name: 'weekly-review' }), deps());
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not be found'));
      expect(openRun).not.toHaveBeenCalled();
    });

    it('finds the newest Copilot session created since the run started', async () => {
      await add({ agent: 'copilot', open: 'copilot' });
      const old = path.join(sessionHome, '.copilot', 'session-state', 'old');
      const fresh = path.join(sessionHome, '.copilot', 'session-state', 'fresh');
      await fs.mkdir(old, { recursive: true });
      await fs.mkdir(fresh, { recursive: true });
      await fs.writeFile(path.join(old, 'events.jsonl'), '{}\n');
      await fs.utimes(path.join(old, 'events.jsonl'), new Date('2020-01-01'), new Date('2020-01-01'));
      await fs.writeFile(path.join(fresh, 'events.jsonl'), '{}\n');
      await run(opts({ action: 'run', name: 'weekly-review' }), deps({ now: () => new Date(Date.now() - 60_000) }));
      expect((await loadSchedules())['weekly-review'].last_run?.session_id).toBe('fresh');
      const file = openRun.mock.calls[0][1][2];
      expect(await fs.readFile(file, 'utf8')).toContain("exec 'copilot' '--resume=fresh'");
    });

    it('returns a failing exit code and records it when the agent fails', async () => {
      await add();
      spawnAgent.mockResolvedValueOnce({ code: 3 });
      expect(await run(opts({ action: 'run', name: 'weekly-review' }), deps())).toBe(ExitCode.USER_ERROR);
      expect((await loadSchedules())['weekly-review'].last_run?.exit_code).toBe(3);
    });

    it('records a start failure and reports it', async () => {
      await add();
      spawnAgent.mockRejectedValueOnce(new Error('spawn claude ENOENT'));
      await expect(run(opts({ action: 'run', name: 'weekly-review' }), deps())).rejects.toThrow('Could not start claude');
      expect((await loadSchedules())['weekly-review'].last_run?.exit_code).toBeNull();
    });

    it('reads the env file at run time, not at install time', async () => {
      const file = path.join(home.dir, 'tokens.env');
      await fs.writeFile(file, 'COPILOT_GITHUB_TOKEN=first\n', { mode: 0o600 });
      await add({ agent: 'copilot', envFile: file });
      await fs.writeFile(file, 'COPILOT_GITHUB_TOKEN=second\n');
      await run(opts({ action: 'run', name: 'weekly-review' }), deps());
      expect(spawnAgent.mock.calls[0][2].COPILOT_GITHUB_TOKEN).toBe('second');
      const plist = await fs.readFile(path.join(agentsDir, 'ai.coolhand.schedule.weekly-review.plist'), 'utf8');
      expect(plist).not.toContain('first');
      expect((await fs.readFile(path.join(home.dir, 'schedules.json'), 'utf8'))).not.toContain('second');
    });

    it('refuses to run with an env file other users can read', async () => {
      const file = path.join(home.dir, 'tokens.env');
      await fs.writeFile(file, 'A=1\n', { mode: 0o600 });
      await add({ envFile: file });
      await fs.chmod(file, 0o644);
      await expect(run(opts({ action: 'run', name: 'weekly-review' }), deps())).rejects.toThrow('chmod 600');
      expect(spawnAgent).not.toHaveBeenCalled();
    });

    it('opens an interactive session in Codex without running the agent headless', async () => {
      await add({ mode: 'interactive', open: 'codex', skill: undefined, prompt: 'Review "last week"' });
      await run(opts({ action: 'run', name: 'weekly-review' }), deps());
      expect(spawnAgent).not.toHaveBeenCalled();
      const file = openRun.mock.calls[0][1][2];
      const body = await fs.readFile(file, 'utf8');
      expect(body).toContain(`cd '${home.dir}'`);
      expect(body).toContain(`exec 'codex' 'Review "last week"'`);
    });

    it('errors on an unknown name', async () => {
      await expect(run(opts({ action: 'run', name: 'nope' }), deps())).rejects.toThrow('No schedule named "nope"');
    });
  });

  it('needs an action', async () => {
    await expect(run(opts(), deps())).rejects.toThrow('needs an action');
  });

  it('keeps schedules in a file the loader can round-trip', async () => {
    await saveSchedules({});
    expect(await loadSchedules()).toEqual({});
    expect(os.tmpdir()).toBeTruthy();
  });
});

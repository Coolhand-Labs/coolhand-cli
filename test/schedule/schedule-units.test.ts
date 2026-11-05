import { checkOpen, headlessCommand, interactiveCommand, resumeCommand } from '../../src/schedule/agent.js';
import { describeCadence, parseCadence, validateName, type ScheduleDef } from '../../src/schedule/definition.js';
import { buildPlist, launchdLabel } from '../../src/schedule/launchd.js';
import { commandFileBody, shellQuote } from '../../src/schedule/open.js';
import { parseEnvFile } from '../../src/commands/schedule.js';

const def = (over: Partial<ScheduleDef> = {}): ScheduleDef => ({
  name: 'weekly-review',
  agent: 'claude',
  prompt: '/acme:acme-weekly-review',
  mode: 'headless',
  open: 'none',
  cadence: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 },
  cwd: '/Users/me/reports',
  allow: [],
  path: '/usr/bin:/bin',
  created_at: '2026-11-05T00:00:00.000Z',
  ...over,
});

describe('parseCadence', () => {
  it('reads --weekly DAY@HH:MM', () => {
    expect(parseCadence('Mon@09:30', undefined)).toEqual({ kind: 'weekly', weekday: 1, hour: 9, minute: 30 });
    expect(parseCadence('sun@0:05', undefined)).toEqual({ kind: 'weekly', weekday: 0, hour: 0, minute: 5 });
  });

  it('reads --daily HH:MM', () => {
    expect(parseCadence(undefined, '23:59')).toEqual({ kind: 'daily', hour: 23, minute: 59 });
  });

  it('needs exactly one of the two', () => {
    expect(() => parseCadence(undefined, undefined)).toThrow('exactly one');
    expect(() => parseCadence('mon@09:00', '09:00')).toThrow('exactly one');
  });

  it.each(['monday@09:00', 'mon', 'mon@9', 'mon@24:00', 'mon@09:60', 'mon@09:00@x'])('rejects %s', (bad) => {
    expect(() => parseCadence(bad, undefined)).toThrow();
  });

  it('describes both kinds', () => {
    expect(describeCadence({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 })).toBe('every Monday at 09:00');
    expect(describeCadence({ kind: 'daily', hour: 7, minute: 5 })).toBe('every day at 07:05');
  });
});

describe('validateName', () => {
  it('accepts lowercase names with hyphens', () => {
    expect(validateName('weekly-review-2')).toBe('weekly-review-2');
  });

  it.each([undefined, '', 'Weekly', '-lead', 'has space', '../x', 'a'.repeat(41)])('rejects %s', (bad) => {
    expect(() => validateName(bad as string | undefined)).toThrow('schedule name');
  });
});

describe('headlessCommand', () => {
  it('runs claude -p with a session id, a budget, and the allow-list last', () => {
    const cmd = headlessCommand(def({ allow: ['Read', 'Bash(ls:*)'], max_budget_usd: 2 }), 'abc');
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['-p', '/acme:acme-weekly-review', '--session-id', 'abc', '--max-budget-usd', '2', '--allowedTools', 'Read', 'Bash(ls:*)']);
  });

  it('never disables session persistence, which would leave capture with no transcript', () => {
    expect(headlessCommand(def(), 'abc').args).not.toContain('--no-session-persistence');
    expect(headlessCommand(def({ agent: 'copilot' })).args).not.toContain('--no-session-persistence');
  });

  it('runs copilot -p non-interactively with one --allow-tool per rule', () => {
    const cmd = headlessCommand(def({ agent: 'copilot', allow: ['shell(ls:*)', 'write(notes.md)'], max_ai_credits: 100 }));
    expect(cmd.command).toBe('copilot');
    expect(cmd.args).toEqual([
      '-p', '/acme:acme-weekly-review', '--no-ask-user', '--no-auto-update', '-s',
      '--max-ai-credits', '100', '--allow-tool=shell(ls:*)', '--allow-tool=write(notes.md)',
    ]);
  });
});

describe('interactive and resume commands', () => {
  it('starts each tool with the prompt loaded', () => {
    expect(interactiveCommand('claude', 'hi')).toEqual({ command: 'claude', args: ['hi'] });
    expect(interactiveCommand('codex', 'hi')).toEqual({ command: 'codex', args: ['hi'] });
    expect(interactiveCommand('copilot', 'hi')).toEqual({ command: 'copilot', args: ['-i', 'hi'] });
  });

  it('resumes a session in the agent that wrote it', () => {
    expect(resumeCommand('claude', 'id1')).toEqual({ command: 'claude', args: ['--resume', 'id1'] });
    expect(resumeCommand('copilot', 'id1')).toEqual({ command: 'copilot', args: ['--resume=id1'] });
  });
});

describe('checkOpen', () => {
  it('allows no opener for a headless run', () => {
    expect(checkOpen('headless', 'claude', 'none')).toBeUndefined();
  });

  it('allows reopening with the same agent, or VS Code', () => {
    expect(checkOpen('headless', 'claude', 'claude')).toBeUndefined();
    expect(checkOpen('headless', 'copilot', 'copilot')).toBeUndefined();
    expect(checkOpen('headless', 'copilot', 'vscode')).toBeUndefined();
  });

  it('refuses Codex or the other agent for a headless run, which cannot continue another agent\'s session', () => {
    expect(checkOpen('headless', 'claude', 'codex')).toContain('Codex cannot continue a claude session');
    expect(checkOpen('headless', 'claude', 'copilot')).toContain('cannot continue a claude session');
  });

  it('needs a terminal tool in interactive mode, and refuses VS Code', () => {
    expect(checkOpen('interactive', 'claude', 'codex')).toBeUndefined();
    expect(checkOpen('interactive', 'claude', 'none')).toContain('needs --open');
    expect(checkOpen('interactive', 'claude', 'vscode')).toContain('cannot open VS Code');
  });
});

describe('buildPlist', () => {
  const plist = (d: ScheduleDef) =>
    buildPlist({ def: d, program: ['/opt/node', '/opt/coolhand/bin.js', 'schedule', 'run', d.name], logPath: '/logs/a&b.log', env: { PATH: '/a:/b' } });

  it('labels the job and sets a weekly calendar interval', () => {
    const xml = plist(def());
    expect(xml).toContain(`<string>${launchdLabel('weekly-review')}</string>`);
    expect(xml).toContain('<key>Weekday</key><integer>1</integer>');
    expect(xml).toContain('<key>Hour</key><integer>9</integer>');
    expect(xml).toContain('<key>Minute</key><integer>0</integer>');
  });

  it('leaves Weekday out of a daily job', () => {
    expect(plist(def({ cadence: { kind: 'daily', hour: 7, minute: 5 } }))).not.toContain('Weekday');
  });

  it('runs coolhand schedule run NAME, not the agent, and escapes XML', () => {
    const xml = plist(def());
    expect(xml).toContain('<string>schedule</string>');
    expect(xml).toContain('<string>run</string>');
    expect(xml).toContain('/logs/a&amp;b.log');
    expect(xml).not.toContain('acme-weekly-review');
  });

  it('carries no prompt or secrets', () => {
    expect(plist(def({ prompt: 'secret prompt text' }))).not.toContain('secret prompt text');
  });
});

describe('shell quoting for the Terminal launcher', () => {
  it('keeps a hostile prompt one literal argument', () => {
    const body = commandFileBody('/Users/me/it\'s here', { command: 'claude', args: ["it's $(touch /tmp/x) `id`"] });
    expect(body).toContain(`cd ${shellQuote("/Users/me/it's here")} || exit 1`);
    expect(body).toContain(`exec 'claude' 'it'\\''s $(touch /tmp/x) \`id\`'`);
    expect(body.startsWith('#!/bin/zsh -l\n')).toBe(true);
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, skipping comments and blanks, with export and quotes', () => {
    expect(parseEnvFile('# c\n\nexport A=1\nB="two words"\nC=\'x\'\nnot a line\nD=a=b\n')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'a=b' });
  });
});

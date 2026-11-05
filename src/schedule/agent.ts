import type { OpenTarget, ScheduleAgent, ScheduleDef } from './definition.js';

export interface AgentCommand {
  command: string;
  args: string[];
}

/**
 * The unattended run: `claude -p` / `copilot -p`. Never `--no-session-persistence`: without a transcript on disk,
 * `capture-turn` cannot tell which skill ran and sends nothing.
 *
 * Claude gets a session id up front so the finished run can be reopened with `claude --resume <id>`. Copilot picks its
 * own id, which `findCopilotSession` looks up afterwards.
 */
export function headlessCommand(def: ScheduleDef, sessionId?: string): AgentCommand {
  if (def.agent === 'claude') {
    const args = ['-p', def.prompt];
    if (sessionId) {
      args.push('--session-id', sessionId);
    }
    if (def.max_budget_usd !== undefined) {
      args.push('--max-budget-usd', String(def.max_budget_usd));
    }
    // Variadic, so it goes last: it would otherwise swallow the flags after it.
    if (def.allow.length > 0) {
      args.push('--allowedTools', ...def.allow);
    }
    return { command: 'claude', args };
  }
  const args = ['-p', def.prompt, '--no-ask-user', '--no-auto-update', '-s'];
  if (def.max_ai_credits !== undefined) {
    args.push('--max-ai-credits', String(def.max_ai_credits));
  }
  for (const rule of def.allow) {
    args.push(`--allow-tool=${rule}`);
  }
  return { command: 'copilot', args };
}

/** Start the agent interactively with the prompt already typed in. */
export function interactiveCommand(agent: ScheduleAgent | 'codex', prompt: string): AgentCommand {
  if (agent === 'copilot') {
    return { command: 'copilot', args: ['-i', prompt] };
  }
  return { command: agent, args: [prompt] };
}

/** Reopen a finished headless run so it can be read or continued, in the agent that produced it. */
export function resumeCommand(agent: ScheduleAgent, sessionId: string): AgentCommand {
  return agent === 'claude'
    ? { command: 'claude', args: ['--resume', sessionId] }
    : { command: 'copilot', args: [`--resume=${sessionId}`] };
}

export type OpenKind = 'resume' | 'transcript' | 'interactive';

/**
 * What `--open TARGET` can mean, given the schedule's mode. Returns an error message for a combination that cannot
 * work, so `schedule add` refuses it up front rather than failing at 9am with nobody watching.
 *
 * - headless run, then open: `claude`/`copilot` resume that agent's own session (it must be the same agent), and
 *   `vscode` opens the transcript file. Codex cannot continue another agent's session.
 * - interactive: `claude`, `copilot` and `codex` start a session in a Terminal window with the prompt loaded.
 *   VS Code has no verified way to do that yet.
 */
export function checkOpen(mode: ScheduleDef['mode'], agent: ScheduleAgent, open: OpenTarget): string | undefined {
  if (open === 'none') {
    return mode === 'interactive' ? '--mode interactive needs --open claude, copilot or codex' : undefined;
  }
  if (mode === 'interactive') {
    if (open === 'vscode') {
      return '--mode interactive cannot open VS Code yet; use --open claude, copilot or codex, or --mode headless --open vscode';
    }
    return undefined;
  }
  if (open === 'codex') {
    return `Codex cannot continue a ${agent} session. Use --mode interactive --open codex to start a new Codex session with the prompt, or --open ${agent} / vscode to reopen this run`;
  }
  if ((open === 'claude' || open === 'copilot') && open !== agent) {
    return `--open ${open} cannot continue a ${agent} session. Use --open ${agent} or vscode`;
  }
  return undefined;
}

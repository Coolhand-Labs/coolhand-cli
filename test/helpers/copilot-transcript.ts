import { promises as fs } from 'fs';
import * as path from 'path';

export const FIXTURES = path.join(__dirname, '..', 'fixtures', 'copilot');

/** A recorded hook payload, with its transcript path pointed at the file the test wrote. */
export async function recordedHook(name: string, transcriptPath: string): Promise<Record<string, unknown>> {
  const payload = JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'));
  return { ...payload, transcript_path: transcriptPath };
}

/** The recorded `events.jsonl` up to (not including) its `n`th user message, as it stood when the (n-1)th turn's `Stop` fired. */
export async function recordedTranscriptBefore(name: string, userMessage: number): Promise<string> {
  const lines = (await fs.readFile(path.join(FIXTURES, name), 'utf8')).trim().split('\n');
  let seen = 0;
  const cut = lines.findIndex((l) => l.startsWith('{"type":"user.message"') && ++seen === userMessage);
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n') + '\n';
}

let counter = 0;
const stamp = (): string => new Date(Date.UTC(2026, 10, 2, 12, 0, counter++)).toISOString();
const line = (type: string, data: Record<string, unknown>): string => JSON.stringify({ type, data, timestamp: stamp() });

/** Hand-built transcript events in the shape Copilot writes. */
export const events = {
  skill: (name: string, dir = `/work/.github/skills/${name}`) => line('skill.invoked', { name, path: `${dir}/SKILL.md`, content: `# ${name}\n\nSKILL BODY` }),
  user: (content: string) => line('user.message', { content }),
  assistant: (content: string, toolRequests: Array<{ toolCallId: string; name: string; arguments: unknown }> = [], messageId = `m-${counter}`) =>
    line('assistant.message', { messageId, model: 'gpt-test', content, toolRequests }),
  result: (toolCallId: string, content: string) => line('tool.execution_complete', { toolCallId, success: true, result: { content } }),
};

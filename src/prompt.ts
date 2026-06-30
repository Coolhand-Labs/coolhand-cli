import * as readline from 'readline';

/**
 * True only when both stdin and stdout are attached to a real terminal. Used to gate
 * every interactive prompt: in a sandbox, pipe, or CI run there is no terminal, so we
 * must never block waiting for input.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ask a yes/no question. Returns `false` immediately when not interactive (no TTY),
 * so non-interactive callers — the main `report-blocker` audience — are never blocked.
 * The prompt is written to stderr so stdout stays clean for machine-readable output.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!isInteractive()) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

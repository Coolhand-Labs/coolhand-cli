const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Run `fn` with every `console` method turned into a no-op, then restore them. coolhand-node
 * ignores its `silent: true` option when a request fails (it calls `console.error` regardless), and
 * a hook must put nothing on stdout or stderr — whatever it prints lands in the agent's hook channel.
 */
export async function withSilencedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const target = console as unknown as Record<string, unknown>;
  const saved = METHODS.map((method) => target[method]);
  for (const method of METHODS) {
    target[method] = () => undefined;
  }
  try {
    return await fn();
  } finally {
    METHODS.forEach((method, i) => {
      target[method] = saved[i];
    });
  }
}

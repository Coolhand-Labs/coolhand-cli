/**
 * On Windows, .cmd shims cannot be spawned without a shell. Rather than using
 * shell:true (which forwards args as an unquoted string to cmd.exe, enabling
 * metacharacter injection), we invoke cmd.exe /d /s /c directly with the command
 * and each arg double-quoted and windowsVerbatimArguments:true so Node does not
 * re-quote them.
 *
 * Quoting rules applied to the command and every arg:
 *   1. Double trailing backslashes (a trailing \ would escape the closing ")
 *   2. Escape embedded " as ""
 *   3. Escape % as %% to prevent cmd.exe environment-variable expansion
 *   4. Wrap in double quotes unconditionally
 */
function escapeForCmdExe(s: string): string {
  return s
    .replace(/(\\+)$/, '$1$1')  // double trailing backslashes
    .replace(/"/g, '""')         // escape embedded quotes
    .replace(/%/g, '%%');        // prevent env-var expansion
}

export function resolveWrapSpawn(
  cmd: string,
  args: string[],
  platform = process.platform
): { cmd: string; spawnArgs: string[]; windowsVerbatimArguments?: true } {
  if (platform !== 'win32') {
    return { cmd, spawnArgs: args };
  }
  const escapedCmd = `"${escapeForCmdExe(cmd)}"`;
  const escapedArgs = args.map((a) => `"${escapeForCmdExe(a)}"`);
  return {
    cmd: process.env['ComSpec'] ?? 'cmd.exe',
    spawnArgs: ['/d', '/s', '/c', [escapedCmd, ...escapedArgs].join(' ')],
    windowsVerbatimArguments: true,
  };
}

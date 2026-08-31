// Feature flagging (issue #57): a command tagged with a featureGroup is hidden from help and
// blocked at dispatch unless its group is enabled. Enabled groups come from the
// COOLHAND_FEATURE_FLAGS env var, falling back to the config file's feature_flags.

export const FEATURE_FLAGS_ENV = 'COOLHAND_FEATURE_FLAGS';

export interface Gateable {
  readonly featureGroup?: string;
}

export function parseGroups(raw: string): string[] {
  return raw
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
}

/**
 * The env var wins even when empty (`COOLHAND_FEATURE_FLAGS=`): an explicit empty override
 * means "everything off for this run", so it must not fall through to the config file.
 */
export function enabledGroups(config: { feature_flags?: readonly string[] }): Set<string> {
  const fromEnv = process.env[FEATURE_FLAGS_ENV];
  if (fromEnv !== undefined) {
    return new Set(parseGroups(fromEnv));
  }
  if (config.feature_flags && config.feature_flags.length > 0) {
    return new Set(config.feature_flags);
  }
  return new Set();
}

/** The group blocking a command, or null when it has no group or its group is enabled. */
export function blockingGroup(command: Gateable, enabled: Set<string>): string | null {
  if (command.featureGroup === undefined) {
    return null;
  }
  return enabled.has(command.featureGroup) ? null : command.featureGroup;
}

export function visibleCommands<T extends Gateable>(commands: readonly T[], enabled: Set<string>): T[] {
  return commands.filter((command) => blockingGroup(command, enabled) === null);
}

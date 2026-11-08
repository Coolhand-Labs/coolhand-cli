/** A release must have been on the registry at least this long before we install it. */
export const BAKE_PERIOD_MS = 48 * 60 * 60 * 1000;

/** The subset of the npm registry packument (`GET /<package>`) that selection needs. */
export interface Packument {
  'dist-tags'?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, { deprecated?: string }>;
}

export type Semver = readonly [number, number, number];

const STABLE_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parses `MAJOR.MINOR.PATCH`; returns null for prereleases, build metadata, or anything else. */
export function parseStable(version: string): Semver | null {
  const m = STABLE_SEMVER.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export interface SelectOptions {
  current: string;
  now: number;
  bakeMs?: number;
}

/**
 * Pick the version to upgrade to: the highest stable release that is newer than `current`,
 * has been published for at least the bake period, is not deprecated, and is not above the
 * registry's `latest` dist-tag. Capping at `latest` means rolling that tag back is enough to
 * stop a bad release from spreading; a version that was unpublished is no longer in `versions`.
 * Returns null when nothing qualifies (including when `current` is itself ahead of `latest`).
 */
export function selectUpdate(packument: Packument, opts: SelectOptions): string | null {
  const current = parseStable(opts.current);
  const latest = parseStable(packument['dist-tags']?.latest ?? '');
  if (!current || !latest) {
    return null;
  }
  const bakeMs = opts.bakeMs ?? BAKE_PERIOD_MS;

  let best: { version: string; semver: Semver } | null = null;
  for (const [version, meta] of Object.entries(packument.versions ?? {})) {
    const semver = parseStable(version);
    if (!semver || meta?.deprecated) {
      continue;
    }
    if (compareSemver(semver, current) <= 0 || compareSemver(semver, latest) > 0) {
      continue;
    }
    const published = Date.parse(packument.time?.[version] ?? '');
    if (Number.isNaN(published) || opts.now - published < bakeMs) {
      continue;
    }
    if (!best || compareSemver(semver, best.semver) > 0) {
      best = { version, semver };
    }
  }
  return best?.version ?? null;
}

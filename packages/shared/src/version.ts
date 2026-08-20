/**
 * Daemon version support, shared so the panel and the daemon agree on the rules.
 *
 * Nodes are updated one at a time and by hand — a phone in someone's bedroom does not get
 * redeployed because the panel did — so a fleet is normally running two or three different
 * daemon builds at once. That is fine until the panel calls something the older ones do
 * not have, at which point the failure surfaces as a confusing error about the feature
 * rather than about the node being old.
 */

/**
 * Oldest daemon this panel can drive completely.
 *
 * Bump this when the panel starts *depending* on a daemon endpoint, not on every release —
 * the point is to flag nodes that will actually misbehave, and a check that complains about
 * every patch bump trains people to ignore it.
 *
 * 1.2.15 is the build that added POST /api/v1/system/games, which the node page needs to
 * change what a node hosts.
 */
export const MIN_SUPPORTED_DAEMON_VERSION = '1.2.15';

export type VersionComparison = -1 | 0 | 1;

/**
 * Semver-ish comparison: -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Deliberately tolerant. Versions arrive from a node the panel does not control, so a
 * pre-release suffix, a short "1.3" or a build tag must not throw — anything unparseable
 * in a segment counts as 0, which orders it before a real number rather than crashing a
 * health check.
 */
export function compareVersions(a: string, b: string): VersionComparison {
  /*
   * The pre-release suffix is split off before the numbers are compared, rather than
   * treated as more segments. Folding it in makes "1.2.15-rc.1" parse as [1,2,15,0,1] and
   * sort *after* "1.2.15" — backwards, and backwards in the direction that matters: a
   * release candidate would read as newer than the release it precedes, so a node running
   * one would be reported as up to date.
   */
  const parse = (v: string) => {
    const cleaned = String(v).trim().replace(/^v/i, '');
    const [core, ...rest] = cleaned.split('-');
    return {
      numbers: core.split('.').map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      }),
      // Build metadata (`+sha`) is not part of precedence, so it is dropped rather than
      // being mistaken for a pre-release.
      prerelease: rest.join('-').split('+')[0],
    };
  };

  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.numbers.length, right.numbers.length);

  for (let i = 0; i < len; i++) {
    const l = left.numbers[i] ?? 0;
    const r = right.numbers[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }

  // Same numbers: a version carrying a pre-release comes before one that does not.
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease !== right.prerelease) return left.prerelease < right.prerelease ? -1 : 1;
  return 0;
}

export type DaemonVersionState = 'current' | 'outdated' | 'ahead' | 'unknown';

/**
 * How a node's daemon version stands against what this panel expects.
 *
 * `unknown` covers a daemon too old to report a version at all, which is itself evidence
 * that it is behind — but not proof of how far, so it is reported as its own state rather
 * than folded into `outdated`.
 *
 * `ahead` is normal during a rollout: the node was updated before the panel was.
 */
export function daemonVersionState(
  reported: string | null | undefined,
  minimum: string = MIN_SUPPORTED_DAEMON_VERSION
): DaemonVersionState {
  if (!reported) return 'unknown';
  const cmp = compareVersions(reported, minimum);
  if (cmp < 0) return 'outdated';
  if (cmp > 0) return 'ahead';
  return 'current';
}

export type TmodCompatibility = 'ok' | 'older' | 'newer' | 'incompatible' | 'unknown';

/**
 * Whether a `.tmod` built for one tModLoader will load on another.
 *
 * Every `.tmod` records the tModLoader it was compiled against, and the server says plainly
 * in its log when the two disagree — but only once it has already tried to load the mod,
 * failed, disabled it, and begun unloading. That cascade is what takes a server down, and
 * by then the operator is reading a stack trace from a mod that was merely nearby.
 *
 * The distinction that matters is not "older" but "from before the format changed".
 * tModLoader versions went date-based with the 1.4 rewrite: anything numbered 0.x or 1.x
 * targets Terraria 1.3 and cannot work here at all, while a 2024 build on a 2026 server is
 * ordinary and usually fine. Reporting those two the same way would either cry wolf on
 * every slightly-old mod or say nothing about the ones that genuinely cannot run.
 */
export function tmodCompatibility(
  builtFor: string | null | undefined,
  serverBuild: string
): TmodCompatibility {
  if (!builtFor) return 'unknown';

  const major = parseInt(String(builtFor).trim().replace(/^v/i, '').split('.')[0], 10);
  if (!Number.isFinite(major)) return 'unknown';

  // Date-based versioning began with the 1.4 rewrite. A pre-1.4 mod is not old, it is for
  // a different game version, and no amount of tolerance will load it.
  if (major < 2000) return 'incompatible';

  const cmp = compareVersions(builtFor, serverBuild);
  if (cmp === 0) return 'ok';
  return cmp < 0 ? 'older' : 'newer';
}

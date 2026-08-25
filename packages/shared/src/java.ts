/*
 * Which Java a Minecraft version needs.
 *
 * Lives in shared because two sides ask the same question and must not answer it
 * differently. The daemon asks before launching a server, to refuse a jar its JVM
 * cannot load; the panel asks before migrating one, to refuse a destination that
 * would strand it. A node that says "requires Java 25" while the panel thinks 21
 * would do is worse than either check alone.
 */

import { Game } from './enums';

/** Java major version each Minecraft version needs. */
export function requiredJavaMajor(mcVersion?: string): number {
  const v = mcVersion || '26.2';

  if (v.startsWith('26') || v.startsWith('25') || v.startsWith('1.22')) return 25;

  const verMatch = v.match(/^1\.(\d+)/);
  if (verMatch && parseInt(verMatch[1], 10) >= 21) return 21;

  return 17;
}

/**
 * Whether a node's Java can run a given server. A message to show, or null.
 *
 * `javaMajor` is what the node reported as the newest JDK it can reach. Null or
 * undefined means it did not say — a daemon older than the field, or one whose probe
 * failed — and that passes. An unknown is not evidence of a problem, and refusing
 * every migration to every node that has not been updated yet would break a working
 * feature to prevent a message.
 *
 * Only Minecraft is judged. Terraria's server is a native binary that needs no JVM at
 * all, and its version numbers look enough like Minecraft's ("1.4.4.9") that running
 * them through the mapping would invent a Java requirement out of nothing.
 */
export function javaSupportViolation(
  nodeName: string,
  game: string | undefined,
  mcVersion: string | undefined,
  javaMajor: number | null | undefined
): string | null {
  if (game !== undefined && game !== Game.MINECRAFT) return null;

  const required = requiredJavaMajor(mcVersion);
  if (javaMajor == null || javaMajor >= required) return null;

  return (
    `Node "${nodeName}" has Java ${javaMajor}, but Minecraft ${mcVersion || 'this version'} needs ` +
    `Java ${required}. The server would move but could never start there. Install Java ${required} ` +
    `on that node first, or pick a destination that already has it.`
  );
}


/**
 * The *newest* Java a server can run on, or null when nothing stops it.
 *
 * requiredJavaMajor above is a floor: a jar built for Java 21 will not load on 17. That
 * model is right for vanilla, where a newer JVM always runs an older jar, and wrong for
 * old Forge, where the opposite is true — Forge up to 1.16 uses LaunchWrapper, which
 * relies on internals that Java 9 removed. Give it Java 17 and it dies at startup with a
 * reflection error that names neither Java nor Forge.
 *
 * So old Forge has a ceiling as well as a floor, and the two meet: it needs Java 8 and
 * only Java 8. The ceiling is loader-dependent, which is why it takes a loader — vanilla
 * or Paper on 1.12.2 runs happily on a modern JVM and must not be caught by this.
 */
export function maxJavaMajor(mcVersion?: string, loader?: string): number | null {
  if ((loader || '').toUpperCase() !== 'FORGE') return null;

  const match = /^1\.(\d+)/.exec(mcVersion || '');
  if (!match) return null;

  // 1.16 and older: LaunchWrapper, Java 8 only. 1.17 onward Forge moved to the module
  // system and tracks the version's own requirement, so the floor alone governs.
  return parseInt(match[1], 10) <= 16 ? 8 : null;
}

/**
 * Whether the JVM available is too new for this server, as a message or null.
 *
 * `available` is the JDK that would actually be used. Null means it could not be
 * determined, which passes — an unknown is not evidence of a problem.
 */
export function javaTooNewViolation(
  mcVersion: string | undefined,
  loader: string | undefined,
  available: number | null | undefined
): string | null {
  const ceiling = maxJavaMajor(mcVersion, loader);
  if (ceiling === null || available == null || available <= ceiling) return null;

  return (
    `Minecraft ${mcVersion} on Forge needs Java ${ceiling} and cannot run on anything newer, ` +
    `but this node would use Java ${available}. Forge of this era uses LaunchWrapper, which ` +
    `Java ${available} removed the internals for — the server would fail at startup.`
  );
}

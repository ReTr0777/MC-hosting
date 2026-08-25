import { execFile } from 'child_process';
import { maxJavaMajor, requiredJavaMajor } from '@mc-manager/shared';

/*
 * What Java a server needs, and what Java this node actually has.
 *
 * A jar built for a newer Java than the one running it fails with
 * UnsupportedClassVersionError — sixty lines of Fabric loader stack trace whose only
 * useful content is two class-file numbers that mean nothing unless you happen to
 * know 69 is Java 25 and 65 is Java 21. It arrives after the launch appears to have
 * succeeded, so the panel shows a server starting and then dying for no stated
 * reason.
 *
 * It is also entirely predictable before launching. The version is known, the JDK is
 * known, and comparing them costs one `java -version` per JDK for the life of the
 * process.
 */

/** class-file major -> Java major, for turning the JVM's own error back into a version. */
const CLASS_FILE_BASE = 44;

/*
 * The version -> Java mapping is shared with the panel, which asks the same question
 * before migrating a server onto a node. Re-exported so callers here need not know
 * where it lives.
 */
export { requiredJavaMajor, maxJavaMajor };

/**
 * Which JDKs to try for a given requirement, best first.
 *
 * Fallbacks only ever go upward. A newer JVM runs older jars; an older one cannot
 * run newer ones at all, which is the whole failure this file exists to name.
 *
 * This used to fall from 25 back to 21, which could only ever pick a JVM guaranteed
 * to fail — and on a node whose newest JDK is 21, that is precisely what it did
 * before dying with UnsupportedClassVersionError. Nothing is lost by dropping it:
 * such a node falls through to `java` on PATH and the preflight check refuses the
 * launch with a reason either way.
 *
 * 17 keeps no upward fallback. Old Forge packs are the reason — some of them break
 * on a newer JVM, so silently promoting them is not an improvement.
 *
 * The paths are the Docker image's layout (apps/daemon/Dockerfile); a node installed
 * any other way usually has one `java` on PATH and lands on the final fallback.
 */
export const JAVA_PREFERENCE: Record<number, number[]> = {
  25: [25],
  21: [21, 25],
  17: [17],
  /*
   * Java 8 alone, with no upward fallback.
   *
   * Everywhere else here a newer JVM is an acceptable substitute. For old Forge it is the
   * failure: LaunchWrapper needs internals Java 9 removed, so falling back to 17 would
   * pick a JVM guaranteed not to work. Better to end up on `java` and have the preflight
   * say what is missing.
   */
  8: [8],
};

/**
 * Parses a Java major version out of what `java` prints about itself.
 *
 * Two formats, because `-XshowSettings:properties` is exact but a stripped or
 * unusual build may not print it: `java.specification.version = 21`, or the banner
 * line `openjdk version "21.0.5"`. Java 8 and earlier wrote `1.8.0_402`, where the
 * major is the second component.
 */
export function parseJavaMajor(output: string): number | null {
  const spec = output.match(/java\.specification\.version\s*=\s*(\d+(?:\.\d+)?)/);
  const banner = output.match(/version "(\d+)(?:\.(\d+))?/);

  const raw = spec?.[1] ?? (banner ? (banner[1] === '1' ? banner[2] : banner[1]) : undefined);
  if (!raw) return null;

  // "1.8" from the properties form means 8, the same as the banner's 1.8.0_402.
  const major = parseInt(raw.startsWith('1.') ? raw.slice(2) : raw, 10);
  return Number.isFinite(major) && major > 0 ? major : null;
}

/*
 * Cached per command, because this spawns a JVM to ask — several hundred milliseconds
 * on a phone — and the answer cannot change while that path stays put. The promise
 * itself is cached, so two servers starting together ask once between them.
 */
const detected = new Map<string, Promise<number | null>>();

export function detectJavaMajor(javaCmd: string): Promise<number | null> {
  const cached = detected.get(javaCmd);
  if (cached) return cached;

  const probe = new Promise<number | null>((resolve) => {
    execFile(
      javaCmd,
      ['-XshowSettings:properties', '-version'],
      { timeout: 15_000, windowsHide: true },
      (err, stdout, stderr) => {
        /*
         * A failure here is not the caller's problem to report. Java missing entirely
         * surfaces as ENOENT from the real spawn, with a message written for it, and
         * a JDK that cannot answer this should not be blocked from running — that
         * would turn a working node into a broken one over a version probe.
         */
        const output = `${stdout ?? ''}${stderr ?? ''}`;
        resolve(err && !output ? null : parseJavaMajor(output));
      }
    );
  });

  detected.set(javaCmd, probe);
  return probe;
}

/** Forgets cached probes. Only useful when a JDK is installed while the node runs. */
export function clearJavaVersionCache(): void {
  detected.clear();
  bestJava = null;
}

/*
 * The newest Java this node can reach, for the health report.
 *
 * This answers a different question from resolveJavaCmd. That one picks the JDK for
 * one server; this one is a capability — "what is the highest version this machine
 * could run, if asked" — which is what the panel needs to decide whether a server may
 * be migrated here. Reporting the JDK a hypothetical server would get is not the same
 * number and would refuse migrations that are perfectly fine.
 *
 * Every candidate is probed rather than trusting the directory name, because
 * /opt/java/openjdk-21 containing something else is exactly the kind of thing that
 * should not silently decide a migration.
 */
let bestJava: Promise<number | null> | null = null;

export function detectBestJavaMajor(): Promise<number | null> {
  if (bestJava) return bestJava;

  const candidates = [
    ...(process.env.JAVA_BIN ? [process.env.JAVA_BIN] : []),
    ...Object.keys(JAVA_PREFERENCE).map((major) => `/opt/java/openjdk-${major}/bin/java`),
    'java',
  ];

  bestJava = Promise.all(candidates.map((cmd) => detectJavaMajor(cmd))).then((found) => {
    const known = found.filter((major): major is number => major !== null);
    return known.length ? Math.max(...known) : null;
  });

  return bestJava;
}

/**
 * The verdict, given a Java version already determined: a message when this node
 * cannot run this server, or null when it can.
 *
 * Separate from the probe so the decision can be tested without a JDK of each
 * version to hand — the probe is one `execFile`, this is the part with the rules in
 * it.
 *
 * `found === null` means the probe could not read a version, and passes. Refusing to
 * start on a failed probe would break working nodes to prevent an error message.
 */
export function evaluateJava(
  javaCmd: string,
  mcVersion: string | undefined,
  found: number | null,
  loader?: string
): string | null {
  if (found === null) return null;

  /*
   * Too new is checked first, and is a different failure from too old.
   *
   * Forge up to 1.16 needs Java 8 and nothing above it. Checking only the floor passed
   * such a server on Java 17 — which then died inside LaunchWrapper with a reflection
   * error naming neither Java nor Forge.
   */
  /*
   * A ceiling is not a second constraint alongside the floor — it replaces it.
   *
   * requiredJavaMajor answers "what is the oldest modern JVM this version runs on" and
   * bottoms out at 17, which is a sensible default for a version nobody caps. Where a
   * ceiling exists it is because that loader needs one exact JVM: Forge up to 1.16 needs
   * Java 8, not "17 or newer, but also no newer than 8", which is satisfiable by nothing.
   * Consulting both rejected Java 8 for 1.12.2 as too old moments after requiring it.
   */
  const ceiling = maxJavaMajor(mcVersion, loader);
  if (ceiling !== null) {
    if (found === ceiling) return null;
    return found > ceiling
      ? `${loader || 'This loader'} on Minecraft ${mcVersion || 'this version'} needs Java ${ceiling} and ` +
        `cannot run on anything newer, but this node would use Java ${found} (${javaCmd}). Install Java ` +
        `${ceiling} on the node, or point JAVA_BIN at it if it is already installed elsewhere.`
      : `${loader || 'This loader'} on Minecraft ${mcVersion || 'this version'} needs Java ${ceiling}, but ` +
        `this node would use Java ${found} (${javaCmd}). Install Java ${ceiling} on the node.`;
  }

  const required = requiredJavaMajor(mcVersion);
  if (found >= required) return null;

  return (
    `Minecraft ${mcVersion || 'this version'} requires Java ${required}, but this node has Java ${found} ` +
    `(${javaCmd}). Install Java ${required} on the node — or point JAVA_BIN at it if it is already ` +
    `installed elsewhere — or create the server on a version that runs on Java ${found}.`
  );
}

/** The check as the launcher uses it: probe this JDK, then judge it. */
export async function javaVersionProblem(
  javaCmd: string,
  mcVersion?: string,
  loader?: string
): Promise<string | null> {
  return evaluateJava(javaCmd, mcVersion, await detectJavaMajor(javaCmd), loader);
}

/**
 * Turns an UnsupportedClassVersionError into the same explanation, for the case the
 * preflight check could not catch.
 *
 * A modpack's run.sh can invoke its own java, and a server jar can load a bundled
 * library built for something newer than the jar itself, so the error can still
 * arrive from a JVM that passed the check. Recognising it in the log stream means it
 * is explained wherever it comes from.
 */
export function explainClassVersionError(line: string): string | null {
  const match = line.match(/class file version (\d+)\.\d+.*?up to (\d+)\.\d+/);
  if (!match) return null;

  const needs = parseInt(match[1], 10) - CLASS_FILE_BASE;
  const has = parseInt(match[2], 10) - CLASS_FILE_BASE;
  if (!Number.isFinite(needs) || !Number.isFinite(has)) return null;

  return `This file needs Java ${needs}, but the JVM running it is Java ${has}.`;
}

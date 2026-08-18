import { execFile } from 'child_process';
import { requiredJavaMajor } from '@mc-manager/shared';

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
export { requiredJavaMajor };

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
export function evaluateJava(javaCmd: string, mcVersion: string | undefined, found: number | null): string | null {
  const required = requiredJavaMajor(mcVersion);
  if (found === null || found >= required) return null;

  return (
    `Minecraft ${mcVersion || 'this version'} requires Java ${required}, but this node has Java ${found} ` +
    `(${javaCmd}). Install Java ${required} on the node — or point JAVA_BIN at it if it is already ` +
    `installed elsewhere — or create the server on a version that runs on Java ${found}.`
  );
}

/** The check as the launcher uses it: probe this JDK, then judge it. */
export async function javaVersionProblem(javaCmd: string, mcVersion?: string): Promise<string | null> {
  return evaluateJava(javaCmd, mcVersion, await detectJavaMajor(javaCmd));
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

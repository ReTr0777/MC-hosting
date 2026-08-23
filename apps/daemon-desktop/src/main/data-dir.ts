import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

/**
 * Moving the server data directory to another drive.
 *
 * Worlds, modpacks and backups are the largest thing a node holds and the one thing on it
 * that cannot be re-downloaded. A 256 GB system SSD fills up; the owner has a 4 TB drive
 * sitting next to it. So this is a real need — and also the most destructive thing the app
 * can be asked to do, which is why every step below verifies before it deletes.
 *
 * config.json deliberately stays where it is, under userData. It holds the daemon key and
 * the enrolment, it is a few hundred bytes, and a node whose identity lived on a removable
 * drive would lose it the moment that drive was missing at boot.
 */

export interface DataDirInfo {
  path: string;
  /** Bytes on disk under this directory, or null if it could not be walked. */
  sizeBytes: number | null;
  /** Free space on the filesystem holding it, or null when it cannot be read. */
  freeBytes: number | null;
  /** How many servers are stored there — the count that makes a move feel real. */
  serverCount: number;
  writable: boolean;
  exists: boolean;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    // The nearest existing ancestor: a directory about to be created has no filesystem
    // of its own to ask, but the drive it will land on does.
    let probe = path.resolve(dir);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const stats = await fsp.statfs(probe);
    // bavail, not bfree: the difference is a reserve unprivileged writes cannot use.
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

async function directorySize(dir: string): Promise<number | null> {
  let total = 0;
  try {
    const walk = async (current: string): Promise<void> => {
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        // Symlinks are counted as their own (tiny) size rather than followed: a loop
        // would hang the walk, and nothing here creates them deliberately.
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
        else {
          try {
            total += (await fsp.lstat(full)).size;
          } catch {
            /* vanished mid-walk; not worth failing the whole measurement */
          }
        }
      }
    };
    await walk(dir);
    return total;
  } catch {
    return null;
  }
}

/** Whether this process can actually create files here, tested rather than inferred. */
async function isWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.mc-hosting-write-test-${process.pid}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, 'x');
    await fsp.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

export async function inspectDataDir(dir: string): Promise<DataDirInfo> {
  const exists = fs.existsSync(dir);
  let serverCount = 0;
  if (exists) {
    try {
      serverCount = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
    } catch {
      serverCount = 0;
    }
  }
  return {
    path: dir,
    sizeBytes: exists ? await directorySize(dir) : 0,
    freeBytes: await freeBytes(dir),
    serverCount,
    writable: await isWritable(dir),
    exists,
  };
}

export interface MoveCheck {
  ok: boolean;
  /** Why not, in a sentence meant for whoever is at the keyboard. */
  reason?: string;
  /** Set when the move is allowed but worth saying out loud first. */
  warning?: string;
  from: DataDirInfo;
  to: DataDirInfo;
}

/** Some slack over the measured size, for the filesystem's own overhead per file. */
const FREE_SPACE_MARGIN = 1.05;

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Whether moving from one directory to the other can succeed.
 *
 * Checked up front rather than discovered halfway through a 200 GB copy, because a copy
 * that dies on ENOSPC leaves data in both places and the app then has to guess which copy
 * is whole.
 */
export async function checkMove(from: string, to: string): Promise<MoveCheck> {
  const fromInfo = await inspectDataDir(from);
  const toInfo = await inspectDataDir(to);

  const same = path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase();
  if (same) {
    return { ok: false, reason: 'That is where the servers are already.', from: fromInfo, to: toInfo };
  }

  // Copying a directory into its own descendant recurses forever, growing until the
  // disk is full. Case-insensitive because this is Windows.
  const nested = path.resolve(to).toLowerCase().startsWith(path.resolve(from).toLowerCase() + path.sep);
  if (nested) {
    return {
      ok: false,
      reason: 'That folder is inside the current one. Pick somewhere outside it.',
      from: fromInfo,
      to: toInfo,
    };
  }

  if (!toInfo.writable) {
    return {
      ok: false,
      reason: `Nothing can be written to ${to}. Pick a folder on a drive this account can write to.`,
      from: fromInfo,
      to: toInfo,
    };
  }

  if (fromInfo.sizeBytes !== null && toInfo.freeBytes !== null) {
    const needed = fromInfo.sizeBytes * FREE_SPACE_MARGIN;
    if (toInfo.freeBytes < needed) {
      return {
        ok: false,
        reason:
          `That drive has ${gb(toInfo.freeBytes)} free and the servers take ${gb(fromInfo.sizeBytes)}. ` +
          'Free some space or pick another drive.',
        from: fromInfo,
        to: toInfo,
      };
    }
  }

  return {
    ok: true,
    // Not refused: an existing games or backups folder is a perfectly reasonable place to
    // put these. But the server folders land alongside whatever is there, and that is
    // worth knowing before rather than after.
    warning: toInfo.serverCount > 0 ? `${to} already has ${toInfo.serverCount} folders in it.` : undefined,
    from: fromInfo,
    to: toInfo,
  };
}

export interface MoveResult {
  ok: boolean;
  detail: string;
  /** Where the data actually is now — the caller writes this to config, not what it asked for. */
  path: string;
}

/**
 * Confirms every file made it, by name and by size.
 *
 * Not a checksum: these directories run to hundreds of gigabytes, and hashing all of it
 * would take longer than the copy did. Name-and-size catches the failures that actually
 * happen here — a truncated file from a full disk, a subtree skipped by a permission
 * error — which is what has to be true before the original is deleted.
 */
async function verifyCopy(from: string, to: string): Promise<{ ok: boolean; detail: string }> {
  const walk = async (root: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    const recurse = async (current: string): Promise<void> => {
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await recurse(full);
        else out.set(path.relative(root, full), (await fsp.lstat(full)).size);
      }
    };
    await recurse(root);
    return out;
  };

  let source: Map<string, number>;
  let target: Map<string, number>;
  try {
    source = await walk(from);
    target = await walk(to);
  } catch (err: any) {
    return { ok: false, detail: `The copy could not be checked: ${err.message}.` };
  }

  for (const [rel, size] of source) {
    const copied = target.get(rel);
    if (copied === undefined) return { ok: false, detail: `${rel} did not make it across.` };
    if (copied !== size) return { ok: false, detail: `${rel} copied across incomplete.` };
  }

  return { ok: true, detail: `${source.size} files verified.` };
}

/**
 * Copies the data across, verifies it, and only then removes the original.
 *
 * Deliberately not fs.rename: it fails across drives, which is the whole point of the
 * feature. And deliberately copy-then-delete rather than move-as-you-go — if the machine
 * loses power in the middle, everything is still readable at the old path, and the config
 * still points there because it is written last.
 *
 * The caller must have stopped the daemon. Copying a world that a running server is
 * writing into produces a corrupt region file, and nothing here would notice.
 */
export async function moveDataDir(
  from: string,
  to: string,
  onProgress: (message: string) => void = () => {}
): Promise<MoveResult> {
  const check = await checkMove(from, to);
  if (!check.ok) return { ok: false, detail: check.reason ?? 'That move is not possible.', path: from };

  if (!fs.existsSync(from)) {
    // Nothing to carry: a node that has never hosted anything. Just point at the new place.
    await fsp.mkdir(to, { recursive: true });
    return { ok: true, detail: `Servers will be stored in ${to}.`, path: to };
  }

  onProgress(`Copying ${gb(check.from.sizeBytes ?? 0)} to ${to}…`);

  try {
    await fsp.cp(from, to, { recursive: true, force: true, errorOnExist: false });
  } catch (err: any) {
    return {
      ok: false,
      // The original is untouched, and saying so is the most useful half of this message.
      detail: `The copy failed: ${err.message}. Nothing was removed — the servers are still in ${from}.`,
      path: from,
    };
  }

  onProgress('Checking the copy…');
  const verdict = await verifyCopy(from, to);
  if (!verdict.ok) {
    return {
      ok: false,
      detail: `${verdict.detail} Nothing was removed — the servers are still in ${from}.`,
      path: from,
    };
  }

  onProgress('Removing the old copy…');
  try {
    await fsp.rm(from, { recursive: true, force: true });
  } catch (err: any) {
    // The new copy is verified, so the node is fine; there is just a stale copy left
    // behind eating disk. Report it as a success with a chore attached rather than
    // failing a move that did in fact work.
    return {
      ok: true,
      detail: `Servers are now in ${to}. The old folder at ${from} could not be deleted (${err.message}) — remove it by hand to reclaim the space.`,
      path: to,
    };
  }

  return { ok: true, detail: `Servers moved to ${to}.`, path: to };
}

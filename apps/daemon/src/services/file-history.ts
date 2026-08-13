import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Keeps the previous few versions of every config file the panel edits.
 *
 * The file editor writes straight over `server.properties` and mod configs with no undo, so one bad
 * paste at 2am is unrecoverable without a full world backup — a very heavy tool for a one-line
 * mistake. A snapshot is taken *before* each write, which means the newest revision is always the
 * state the file was in before the edit that is about to happen.
 */

/** Revisions live inside the server directory, so they travel with backups, exports and migrations. */
export const HISTORY_DIR = '.file-history';

/** Enough to walk back through an editing session without turning the server dir into an archive. */
const MAX_REVISIONS = 15;

/**
 * Snapshotting a 40 MB world data file would be pointless and slow. Config files are kilobytes;
 * anything past this is not something an undo history helps with.
 */
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/** Extensions worth versioning. A jar or a region file has nothing to diff. */
const TEXT_EXTENSIONS = new Set([
  '.properties', '.json', '.json5', '.toml', '.yml', '.yaml', '.conf', '.cfg',
  '.txt', '.ini', '.snbt', '.md', '.sh', '.bat', '.xml', '.hocon', '.js', '.mcmeta',
]);

export interface Revision {
  id: string;
  savedAt: string;
  size: number;
  /** Lets the caller skip storing a snapshot identical to the newest one. */
  sha1: string;
}

interface RevisionIndex {
  path: string;
  revisions: Revision[];
}

export function isVersionable(relPath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/** Directory holding one file's history. Hashed because a relative path isn't a legal directory name. */
function historyDirFor(serverDir: string, relPath: string): string {
  const key = crypto.createHash('sha1').update(normalize(relPath)).digest('hex').slice(0, 16);
  return path.join(serverDir, HISTORY_DIR, key);
}

function normalize(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function readIndex(dir: string): RevisionIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    if (!parsed || !Array.isArray(parsed.revisions)) return null;
    return parsed as RevisionIndex;
  } catch (e) {
    return null;
  }
}

function writeIndex(dir: string, index: RevisionIndex): void {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
}

/**
 * Stores the file's current contents as a new revision.
 *
 * Called before a write, so a failure here must never block the write itself — losing an undo
 * point is a far smaller problem than refusing to save the user's edit. Returns the revision it
 * created, or null when it declined (binary, too large, unchanged, or the file is new).
 */
export function snapshot(serverDir: string, relPath: string, reason = 'edit'): Revision | null {
  try {
    const absolute = path.join(serverDir, normalize(relPath));
    if (!fs.existsSync(absolute)) return null;

    const stats = fs.statSync(absolute);
    if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) return null;
    if (!isVersionable(relPath)) return null;

    const content = fs.readFileSync(absolute);
    const sha1 = crypto.createHash('sha1').update(content).digest('hex');

    const dir = historyDirFor(serverDir, relPath);
    const index = readIndex(dir) || { path: normalize(relPath), revisions: [] };

    // Saving without changing anything is common in an editor; it shouldn't consume a slot.
    if (index.revisions[0]?.sha1 === sha1) return null;

    fs.mkdirSync(dir, { recursive: true });

    const revision: Revision = {
      id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      savedAt: new Date().toISOString(),
      size: stats.size,
      sha1,
    };

    fs.writeFileSync(path.join(dir, `${revision.id}.snap`), content);
    index.revisions.unshift(revision);

    // Trim oldest-first, deleting the payloads too — an index entry without its snapshot would
    // show up in the panel as a revision that fails to open.
    for (const dropped of index.revisions.splice(MAX_REVISIONS)) {
      try {
        fs.unlinkSync(path.join(dir, `${dropped.id}.snap`));
      } catch (e) {
        // Already gone.
      }
    }

    writeIndex(dir, index);
    return revision;
  } catch (e: any) {
    console.warn(`[FileHistory] Couldn't snapshot '${relPath}': ${e.message}`);
    return null;
  }
}

export function listRevisions(serverDir: string, relPath: string): Revision[] {
  return readIndex(historyDirFor(serverDir, relPath))?.revisions ?? [];
}

/** The stored contents of one revision, or null if the index and the snapshots disagree. */
export function readRevision(serverDir: string, relPath: string, revisionId: string): string | null {
  try {
    const dir = historyDirFor(serverDir, relPath);
    if (!readIndex(dir)?.revisions.some((r) => r.id === revisionId)) return null;
    return fs.readFileSync(path.join(dir, `${revisionId}.snap`), 'utf8');
  } catch (e) {
    return null;
  }
}

/** Removes a file's entire history. Called when the file itself is deleted. */
export function forgetHistory(serverDir: string, relPath: string): void {
  try {
    fs.rmSync(historyDirFor(serverDir, relPath), { recursive: true, force: true });
  } catch (e) {
    // Nothing stored for it.
  }
}

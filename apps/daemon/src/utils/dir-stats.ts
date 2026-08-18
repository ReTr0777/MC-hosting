import fs from 'fs';
import path from 'path';

/*
 * A census of a server directory: how many files, and how many bytes.
 *
 * Migration is the reason this exists. The panel streams a server from one node to
 * another and then deletes the original with deleteData: true, and until now the only
 * evidence that the copy arrived intact was an HTTP status. A gzip stream cut short
 * usually makes tar exit non-zero, but "usually" is not a property to delete
 * someone's world on — and nothing at all caught an extraction that succeeded while
 * writing less than was sent.
 *
 * Counting both files and bytes is deliberate. Bytes alone miss a directory that
 * arrived empty but sized; file counts alone miss truncated files.
 */

export interface DirStats {
  files: number;
  bytes: number;
}

/**
 * Walks `dir` and totals its regular files. A missing directory is zero of both,
 * which is the truthful answer to "what is there" rather than an error to handle.
 *
 * Symlinks are counted as entries but never followed: a world with a link pointing
 * back up its own tree would otherwise walk forever, and tar does not follow them
 * either, so following here would compare a number against one nothing produced.
 */
export function dirStats(dir: string): DirStats {
  let files = 0;
  let bytes = 0;

  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory that cannot be read contributes nothing rather than failing the
      // whole census. Under-counting the source is the safe direction: it can only
      // make verification stricter, never wave a bad transfer through.
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // Vanished between readdir and stat. Still a file that was there.
        }
      } else if (entry.isSymbolicLink()) {
        files++;
      }
    }
  };

  walk(dir);
  return { files, bytes };
}

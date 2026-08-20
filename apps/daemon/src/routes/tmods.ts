import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import {
  modsDir, readEnabledMods, writeEnabledMods, readModInternalName,
} from '../games/tmodloader';
import { bareServerId } from '../services/runtime/lifecycle';

/**
 * `.tmod` management for tModLoader servers.
 *
 * tModLoader has no open mod API — its browser is Steam Workshop, which needs a Steam
 * install and an account on every node — so mods arrive as files the operator supplies.
 * What the panel adds over dropping them in with a file manager is the half that is easy
 * to get wrong: `enabled.json`.
 *
 * That file, not the folder, decides what loads. A `.tmod` sitting in Mods/ with no entry
 * there is present, visible, and simply off, with nothing in the log to say so. And the
 * name it must be listed under is the mod's *internal* name, which is regularly not the
 * filename — `Calamity Mod v2.0.tmod` calls itself `CalamityMod` — so listing it by
 * filename produces a mod that looks enabled and never loads.
 */

const router = Router();

interface ModEntry {
  /** Internal name: what enabled.json must contain. */
  name: string;
  fileName: string;
  sizeBytes: number;
  enabled: boolean;
  /** True when the internal name had to be guessed from the filename. */
  nameGuessed: boolean;
}

/**
 * The server's directory on disk.
 *
 * The panel addresses a server by its *target* — `process-<id>` or `mc-server-<id>` —
 * because that is what identifies a running process or container. The directory is named
 * by the bare id, so the prefix has to come off first. Every other route that touches the
 * filesystem does this (see servers.ts); missing it here made the daemon look in a path
 * that never exists, which failed in the worst possible way: uploads returned 404 while
 * the listing happily returned 200 and an empty array, because "no directory" and "no
 * mods" are indistinguishable to a read.
 */
function serverDirFor(target: string): string {
  return path.join(getConfig().dataDir, bareServerId(target));
}

/**
 * Rejects anything that is not a plain `.tmod` filename.
 *
 * The name reaches here from a browser upload and is used to build a path, so a
 * traversal here would let a caller write anywhere the daemon can — and the daemon runs
 * as root on a typical Unraid install.
 */
function safeModFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 200) return null;
  if (!name.toLowerCase().endsWith('.tmod')) return null;
  // basename alone is not enough: it leaves "..", which is a valid basename.
  if (name !== path.basename(name) || name.includes('..')) return null;
  return name;
}

function listMods(serverDir: string): ModEntry[] {
  const dir = modsDir(serverDir);
  if (!fs.existsSync(dir)) return [];

  const enabled = new Set(readEnabledMods(serverDir));

  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.tmod'))
    .map((fileName) => {
      const full = path.join(dir, fileName);
      const internal = readModInternalName(full);
      // Falling back to the filename is a guess, and flagged as one — better than
      // hiding a mod whose header we could not read.
      const name = internal ?? fileName.replace(/\.tmod$/i, '');
      return {
        name,
        fileName,
        sizeBytes: fs.statSync(full).size,
        enabled: enabled.has(name),
        nameGuessed: internal === null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/v1/servers/:serverId/tmods
router.get('/:serverId/tmods', (req: Request, res: Response) => {
  try {
    const serverDir = serverDirFor(req.params.serverId);
    const mods = listMods(serverDir);

    /*
     * Names listed as enabled with no file behind them. tModLoader ignores these, but
     * they are worth surfacing: they are what a restore from a backup taken on a server
     * with more mods leaves behind, and they explain a world that will not load.
     */
    const present = new Set(mods.map((m) => m.name));
    const missing = readEnabledMods(serverDir).filter((n) => !present.has(n));

    res.json({ mods, missing });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list mods', details: err.message });
  }
});

/*
 * POST /api/v1/servers/:serverId/tmods?fileName=Something.tmod
 *
 * Raw body, streamed to disk, matching upload-pack. `.tmod` files are single-digit
 * megabytes at most, but streaming costs nothing and keeps one large mod from being held
 * in memory alongside every running server on the node.
 *
 * Uploading does not enable: a mod that started loading the moment its file arrived would
 * make an upload a change to a running world rather than a change to a folder.
 */
router.post('/:serverId/tmods', async (req: Request, res: Response) => {
  try {
    const fileName = safeModFileName(req.query.fileName);
    if (!fileName) {
      return res.status(400).json({
        error: 'fileName must be a plain .tmod filename, with no path separators.',
      });
    }

    const serverDir = serverDirFor(req.params.serverId);
    if (!fs.existsSync(serverDir)) {
      return res.status(404).json({ error: 'No such server on this node' });
    }

    const dir = modsDir(serverDir);
    fs.mkdirSync(dir, { recursive: true });

    // Written to a temporary name and renamed into place, so an interrupted upload cannot
    // leave a truncated `.tmod` that the list shows as a real mod and the server refuses
    // to load with an unrelated-looking error.
    const finalPath = path.join(dir, fileName);
    const tempPath = `${finalPath}.uploading`;

    const writeStream = fs.createWriteStream(tempPath);
    req.pipe(writeStream);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    const internal = readModInternalName(tempPath);
    if (!internal) {
      fs.rmSync(tempPath, { force: true });
      return res.status(400).json({
        error:
          `${fileName} is not a readable .tmod file. It may have been renamed from another ` +
          'format, or truncated in transit.',
      });
    }

    fs.renameSync(tempPath, finalPath);
    console.log(`[tModLoader] Installed mod '${internal}' (${fileName}) for ${req.params.serverId}`);

    res.json({ success: true, name: internal, fileName });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to upload mod', details: err.message });
  }
});

/*
 * PATCH /api/v1/servers/:serverId/tmods/:name  { enabled: boolean }
 *
 * Keyed by internal name because that is what enabled.json holds. Takes effect on the
 * next start — tModLoader reads this file once, during boot.
 */
router.patch('/:serverId/tmods/:name', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }

    const serverDir = serverDirFor(req.params.serverId);
    const known = listMods(serverDir);

    if (enabled && !known.some((m) => m.name === name)) {
      return res.status(404).json({
        error: `No mod named '${name}' is installed on this server.`,
      });
    }

    const current = readEnabledMods(serverDir);
    const next = enabled ? [...current, name] : current.filter((n) => n !== name);
    writeEnabledMods(serverDir, next);

    res.json({ success: true, enabled, restartRequired: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to change the mod', details: err.message });
  }
});

/*
 * DELETE /api/v1/servers/:serverId/tmods/:fileName
 *
 * Removes the entry from enabled.json as well as the file. Deleting only the file leaves
 * a name enabled with nothing behind it, which is exactly the state the `missing` list
 * above exists to report.
 */
router.delete('/:serverId/tmods/:fileName', (req: Request, res: Response) => {
  try {
    const fileName = safeModFileName(req.params.fileName);
    if (!fileName) {
      return res.status(400).json({ error: 'Not a valid .tmod filename' });
    }

    const serverDir = serverDirFor(req.params.serverId);
    const full = path.join(modsDir(serverDir), fileName);
    if (!fs.existsSync(full)) {
      return res.status(404).json({ error: `${fileName} is not installed on this server.` });
    }

    const internal = readModInternalName(full) ?? fileName.replace(/\.tmod$/i, '');
    fs.rmSync(full, { force: true });
    writeEnabledMods(serverDir, readEnabledMods(serverDir).filter((n) => n !== internal));

    console.log(`[tModLoader] Removed mod '${internal}' (${fileName}) from ${req.params.serverId}`);
    res.json({ success: true, restartRequired: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to remove the mod', details: err.message });
  }
});

export default router;

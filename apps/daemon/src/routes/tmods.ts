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

/**
 * Validates a freshly-written file and moves it into Mods/.
 *
 * Shared by the direct and chunked uploads so both reject the same things. Returns the
 * mod's internal name, or null when the file is not a readable `.tmod` — in which case
 * the temporary file is removed rather than left to appear in the mod list as something
 * the server will refuse to load for reasons that point at the wrong place.
 */
function installTmod(serverDir: string, fileName: string, tempPath: string): string | null {
  const internal = readModInternalName(tempPath);
  if (!internal) {
    fs.rmSync(tempPath, { force: true });
    return null;
  }

  const dir = modsDir(serverDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(tempPath, path.join(dir, fileName));
  return internal;
}

/*
 * POST /api/v1/servers/:serverId/tmods/complete   { uploadId, fileName, totalChunks }
 *
 * Finishes an upload sent through /upload-chunk, which exists because Cloudflare refuses a
 * request body over 100 MB and the largest mods are comfortably past that — Calamity's
 * music pack alone is several times the limit.
 *
 * The chunks themselves reuse the existing upload-chunk endpoint rather than getting their
 * own: that path has been carrying serverpacks across this same deployment for a long
 * time, and a second implementation of chunk storage would be a second thing to get wrong.
 * Only the assembly differs, because a mod is installed rather than extracted.
 */
router.post('/:serverId/tmods/complete', async (req: Request, res: Response) => {
  try {
    const fileName = safeModFileName(req.body?.fileName);
    const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId : '';
    const totalChunks = Number(req.body?.totalChunks);

    if (!fileName) {
      return res.status(400).json({ error: 'fileName must be a plain .tmod filename.' });
    }
    // The upload id builds a path, so it is held to the same standard as the filename.
    if (!uploadId || !/^[A-Za-z0-9_.-]{1,128}$/.test(uploadId)) {
      return res.status(400).json({ error: 'uploadId is missing or malformed.' });
    }
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 10_000) {
      return res.status(400).json({ error: 'totalChunks is missing or out of range.' });
    }

    const serverDir = serverDirFor(req.params.serverId);
    if (!fs.existsSync(serverDir)) {
      return res.status(404).json({ error: 'No such server on this node' });
    }

    const uploadTmpDir = path.join(serverDir, '.tmp_uploads', uploadId);
    if (!fs.existsSync(uploadTmpDir)) {
      return res.status(404).json({ error: 'That upload was not found — it may have expired.' });
    }

    // Every chunk is checked before any is read, so a gap is reported as a missing chunk
    // rather than as a corrupt mod file assembled out of what happened to arrive.
    for (let i = 0; i < totalChunks; i++) {
      if (!fs.existsSync(path.join(uploadTmpDir, `chunk_${i}`))) {
        fs.rmSync(uploadTmpDir, { recursive: true, force: true });
        return res.status(400).json({
          error: `Chunk ${i + 1} of ${totalChunks} never arrived, so the mod was not installed.`,
        });
      }
    }

    const tempPath = path.join(serverDir, `.tmp_uploads`, `${uploadId}.assembled`);
    const out = fs.createWriteStream(tempPath);
    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunk = path.join(uploadTmpDir, `chunk_${i}`);
        await new Promise<void>((resolve, reject) => {
          const input = fs.createReadStream(chunk);
          input.on('error', reject);
          out.on('error', reject);
          input.on('end', resolve);
          input.pipe(out, { end: false });
        });
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
      fs.rmSync(uploadTmpDir, { recursive: true, force: true });
    }

    const internal = installTmod(serverDir, fileName, tempPath);
    if (!internal) {
      return res.status(400).json({
        error: `${fileName} is not a readable .tmod file once reassembled.`,
      });
    }

    console.log(`[tModLoader] Installed mod '${internal}' (${fileName}, ${totalChunks} chunks) for ${req.params.serverId}`);
    res.json({ success: true, name: internal, fileName });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to finish the upload', details: err.message });
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
    const tempPath = path.join(dir, `${fileName}.uploading`);

    const writeStream = fs.createWriteStream(tempPath);
    req.pipe(writeStream);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    const internal = installTmod(serverDir, fileName, tempPath);
    if (!internal) {
      return res.status(400).json({
        error:
          `${fileName} is not a readable .tmod file. It may have been renamed from another ` +
          'format, or truncated in transit.',
      });
    }

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

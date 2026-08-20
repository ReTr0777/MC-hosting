import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { spawn } from 'child_process';
import { Game, GAME_LABELS, isGame } from '@mc-manager/shared';
import { getConfig } from '../../config';
import { getGame } from '../../games';
import { isS3Configured, uploadBackup, listRemoteBackups, downloadBackup, deleteRemoteBackup } from './s3-backup';

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  location?: 'local' | 'remote' | 'both';
}

const META_FILE = 'craftcontrol-meta.json';

/**
 * A backup with no recorded game is **Minecraft**, never "unknown, refuse".
 *
 * Every backup taken before games existed predates the field, and treating
 * those as unrestorable would turn a new feature into a Minecraft regression —
 * exactly what plan.md §2 forbids.
 */
function gameFromMeta(raw: string | undefined): Game {
  if (!raw) return Game.MINECRAFT;
  try {
    const game = JSON.parse(raw).game;
    return isGame(game) ? game : Game.MINECRAFT;
  } catch {
    return Game.MINECRAFT;
  }
}

/** The game a server directory belongs to, from the metadata written at create time. */
export function gameOfServerDir(serverDir: string): Game {
  const metaPath = path.join(serverDir, META_FILE);
  if (!fs.existsSync(metaPath)) return Game.MINECRAFT;
  return gameFromMeta(fs.readFileSync(metaPath, 'utf8'));
}

/**
 * The game a backup was taken from.
 *
 * Read out of the archive's own `craftcontrol-meta.json` rather than a separate
 * sidecar: that file is written before anything else at create time and is
 * already inside every backup, so there is no second source of truth to drift.
 */
function gameOfBackupZip(zipPath: string): Game {
  try {
    const entry = new AdmZip(zipPath).getEntry(META_FILE);
    return gameFromMeta(entry?.getData().toString('utf8'));
  } catch {
    return Game.MINECRAFT;
  }
}

/** Never worth archiving: derived, huge, or the backups themselves. */
/**
 * Backups currently being written, by server id.
 *
 * Compressing a multi-gigabyte world takes minutes, and a request held open that long
 * cannot survive the trip: Cloudflare abandons an origin after 100 seconds and answers 524,
 * regardless of what the panel or the daemon are willing to wait. No timeout on either side
 * can change that, so the request has to return before the work is done.
 *
 * That means the work needs somewhere to live and something to report it. This is that:
 * the daemon starts the archive, answers immediately, and the panel watches this instead of
 * a connection.
 */
const running = new Map<string, BackupJob>();

export interface BackupJob {
  serverId: string;
  /** The file being written. Known up front, since the name is chosen before the work. */
  name: string;
  startedAt: string;
  state: 'running' | 'failed';
  /** Set only when state is 'failed'. A finished job is removed rather than kept. */
  error?: string;
}

/** The backup in flight for a server, if any. */
export function backupJobFor(serverId: string): BackupJob | null {
  return running.get(serverId) ?? null;
}

/**
 * Clears a failed job once it has been reported.
 *
 * Failures are kept until somebody asks, because a background job that fails silently is
 * worse than one that fails loudly — nothing else would ever mention it.
 */
export function clearBackupJob(serverId: string): void {
  const job = running.get(serverId);
  if (job && job.state === 'failed') running.delete(serverId);
}

export const EXCLUDED_FROM_BACKUP = ['backups', 'logs', 'crash-reports', '.cache', '.version_mismatch_rescue', '.tmp_uploads'];

/**
 * Writes a zip of `items` from `serverDir`, without blocking the daemon.
 *
 * This used to be adm-zip: `addLocalFolder` then `writeZip`, both entirely synchronous and
 * entirely in memory. On a small world nobody noticed. On an 8 GB one the event loop froze
 * for the whole compression — the daemon answered no health checks, so the panel recorded
 * the node as offline, every console websocket dropped, and the scheduler skipped a node
 * that was in fact working. Holding a multi-gigabyte archive in a Node heap is also how a
 * backup ends up as a zero-byte file: it fails part-way and leaves the empty target behind.
 *
 * An external archiver fixes both. It runs in its own process, so the event loop stays
 * free, and it streams to disk rather than buffering. `zip` first because its output is the
 * most conventional, then `7z`, which p7zip-full already provides in this image. adm-zip
 * remains as a last resort so a node with neither still takes backups, badly, rather than
 * not at all.
 */
export async function archiveDirectory(serverDir: string, targetZipPath: string, items: string[]): Promise<void> {
  const candidates: Array<{ cmd: string; args: string[] }> = [
    // -r recurse, -q quiet, -y store symlinks as links rather than following them into a
    // loop, -X drop platform metadata that only bloats the archive.
    { cmd: 'zip', args: ['-r', '-q', '-y', '-X', targetZipPath, ...items] },
    // -bd no progress indicator: it writes control codes that would flood the console.
    { cmd: '7z', args: ['a', '-tzip', '-bd', '-y', targetZipPath, ...items] },
  ];

  for (const { cmd, args } of candidates) {
    try {
      await runArchiver(cmd, args, serverDir);
      return;
    } catch (err: any) {
      // A partial archive must never be left where the next attempt or a restore can find
      // it looking finished.
      fs.rmSync(targetZipPath, { force: true });
      if (err?.code === 'ENOENT') continue; // Not installed; try the next one.
      throw err;
    }
  }

  console.warn(
    '[BackupManager] Neither zip nor 7z is available on this node; falling back to in-process ' +
    'compression, which blocks the daemon for the duration and may fail on a large server.'
  );

  const zip = new AdmZip();
  for (const item of items) {
    const itemPath = path.join(serverDir, item);
    if (fs.statSync(itemPath).isDirectory()) zip.addLocalFolder(itemPath, item);
    else zip.addLocalFile(itemPath);
  }
  zip.writeZip(targetZipPath);
}

function runArchiver(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });

    // Kept but capped: the reason a backup failed belongs in the error, and an archiver
    // complaining about thousands of files should not itself become a memory problem.
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} failed with exit code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

export class BackupManager {
  private getBackupDir(serverId: string): string {
    const dataDir = getConfig().dataDir;
    const backupDir = path.join(dataDir, serverId, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
  }

  public async listBackups(serverId: string): Promise<BackupInfo[]> {
    const backupDir = this.getBackupDir(serverId);
    const localFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')) : [];

    const byName = new Map<string, BackupInfo>();
    for (const f of localFiles) {
      const stats = fs.statSync(path.join(backupDir, f));
      byName.set(f, { name: f, sizeBytes: stats.size, createdAt: stats.mtime.toISOString(), location: 'local' });
    }

    let remote: { name: string; sizeBytes: number; createdAt: string }[] = [];
    try {
      remote = await listRemoteBackups(serverId);
    } catch (err: any) {
      console.warn(`[BackupManager] Failed to list remote backups for '${serverId}':`, err.message);
    }

    for (const r of remote) {
      const existing = byName.get(r.name);
      if (existing) {
        existing.location = 'both';
      } else {
        byName.set(r.name, { ...r, location: 'remote' });
      }
    }

    return Array.from(byName.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Starts a backup and returns as soon as it is under way.
   *
   * The caller gets the filename immediately and watches `backupJobFor` for the outcome.
   * Nothing is awaited here on purpose — see the note on `running` for why holding the
   * request open is not an option once a world is large enough to matter.
   */
  public startBackup(serverId: string, customName?: string): BackupJob {
    const existing = running.get(serverId);
    if (existing?.state === 'running') {
      throw new Error(`A backup of this server is already running (${existing.name}).`);
    }

    const name = this.backupFileName(customName);
    const job: BackupJob = { serverId, name, startedAt: new Date().toISOString(), state: 'running' };
    running.set(serverId, job);

    void this.createBackup(serverId, customName, name)
      .then(() => {
        // Removed rather than marked done: the finished archive is in the listing, which
        // is a better source of truth than a job record that would have to be expired.
        running.delete(serverId);
      })
      .catch((err: any) => {
        console.error(`[BackupManager] Backup of '${serverId}' failed:`, err.message);
        running.set(serverId, { ...job, state: 'failed', error: err.message });
      });

    return job;
  }

  /** The archive filename for a backup taken now. Chosen up front so a job can name it. */
  private backupFileName(customName?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeCustomName = customName ? customName.replace(/[^a-zA-Z0-9_-]/g, '_') : 'snapshot';
    return `backup_${timestamp}_${safeCustomName}.zip`;
  }

  public async createBackup(serverId: string, customName?: string, presetFileName?: string): Promise<BackupInfo> {
    const dataDir = getConfig().dataDir;
    const serverDir = path.join(dataDir, serverId);
    const backupDir = this.getBackupDir(serverId);

    if (!fs.existsSync(serverDir)) {
      throw new Error(`Server directory for '${serverId}' does not exist`);
    }

    // The name may already have been chosen by startBackup, so the job and the file agree.
    const fileName = presetFileName ?? this.backupFileName(customName);
    const targetZipPath = path.join(backupDir, fileName);

    const items = fs.readdirSync(serverDir).filter((item) => !EXCLUDED_FROM_BACKUP.includes(item));
    if (items.length === 0) {
      throw new Error(`There is nothing to back up in '${serverId}'.`);
    }

    await archiveDirectory(serverDir, targetZipPath, items);

    /*
     * An archive of zero bytes is not a backup, and it is worse than no backup at all: it
     * sorts newest, it is what a restore offers first, and it looks exactly like a real one
     * in the list. One is sitting in this very server's backup directory from 18 August,
     * created by the synchronous path this replaced.
     */
    const stats = fs.statSync(targetZipPath);
    if (stats.size === 0) {
      fs.rmSync(targetZipPath, { force: true });
      throw new Error(
        'The backup archive came out empty and was discarded. Check free space on the node and its log.'
      );
    }

    console.log(`[BackupManager] Backup created successfully: ${fileName} (${stats.size} bytes)`);

    if (isS3Configured()) {
      try {
        await uploadBackup(serverId, fileName, targetZipPath);
        console.log(`[BackupManager] Uploaded backup '${fileName}' to off-site storage.`);
        if (getConfig().s3RetainLocal === false) {
          fs.unlinkSync(targetZipPath);
        }
      } catch (err: any) {
        console.error(`[BackupManager] Off-site upload failed for '${fileName}' (local copy retained):`, err.message);
      }
    }

    return {
      name: fileName,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    };
  }

  public async restoreBackup(serverId: string, backupName: string): Promise<void> {
    const dataDir = getConfig().dataDir;
    const serverDir = path.join(dataDir, serverId);
    const backupDir = this.getBackupDir(serverId);
    const safeBackupName = path.basename(backupName);
    const zipPath = path.join(backupDir, safeBackupName);

    if (!fs.existsSync(zipPath)) {
      if (!isS3Configured()) {
        throw new Error(`Backup file '${safeBackupName}' does not exist`);
      }
      console.log(`[BackupManager] '${safeBackupName}' not found locally, fetching from off-site storage...`);
      await downloadBackup(serverId, safeBackupName, zipPath);
    }

    // Hard block, before anything destructive happens. A Minecraft world tarball
    // unpacked over a Terraria server produces a server that will not boot and
    // whose original files are gone — so this refuses rather than warning.
    // See plan.md §6.
    const targetGame = gameOfServerDir(serverDir);
    const backupGame = gameOfBackupZip(zipPath);
    if (backupGame !== targetGame) {
      throw new Error(
        `This backup was taken from a ${GAME_LABELS[backupGame]} server and cannot be restored ` +
        `onto a ${GAME_LABELS[targetGame]} one. Restoring it would overwrite the world with files ` +
        `the server cannot read.`
      );
    }

    console.log(`[BackupManager] Restoring backup '${safeBackupName}' for server '${serverId}'...`);

    // Clear existing game directories before unzipping so stale/corrupted files are removed.
    // Minecraft's list is unchanged; another game declares its own on its module.
    const dirsToClear = getGame(targetGame)?.restoreClearDirs
      ?? ['world', 'world_nether', 'world_the_end', 'mods', 'config'];
    for (const item of dirsToClear) {
      const itemPath = path.join(serverDir, item);
      if (fs.existsSync(itemPath)) {
        try {
          fs.rmSync(itemPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (e) {}
      }
    }

    // Use native unzip for speed and reliability, fallback to AdmZip
    try {
      const { execSync } = require('child_process');
      // maxBuffer must be generous: execSync buffers all child output in memory (1MB by default)
      // and kills the process once it overflows, which on a big backup would abort a restore that
      // was working fine. Exit code 1 is unzip's "succeeded with warnings" — not a real failure.
      try {
        execSync(`unzip -q -o "${zipPath}" -d "${serverDir}"`, { stdio: 'pipe', maxBuffer: 512 * 1024 * 1024 });
      } catch (e: any) {
        if (e.status !== 1) throw e;
        console.log(`[Backup Restore] unzip reported non-fatal warnings (exit code 1) — treating restore as successful`);
      }
    } catch (e) {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(serverDir, true);
    }

    // Flatten nested wrapper directory if ZIP contained a single top-level folder
    const items = fs.readdirSync(serverDir).filter(i => i !== 'backups');
    if (items.length === 1 && fs.statSync(path.join(serverDir, items[0])).isDirectory()) {
      const subDir = path.join(serverDir, items[0]);
      console.log(`[BackupManager] Flattening nested backup directory '${items[0]}'...`);
      const subItems = fs.readdirSync(subDir);
      for (const subItem of subItems) {
        fs.renameSync(path.join(subDir, subItem), path.join(serverDir, subItem));
      }
      fs.rmdirSync(subDir);
    }

    // Preserve player inventories & stats if UUID mismatch occurred
    this.preservePlayerInventories(serverDir);

    console.log(`[BackupManager] Restore completed for server '${serverId}' from '${safeBackupName}'`);
  }

  private preservePlayerInventories(serverDir: string): void {
    const playerdataDir = path.join(serverDir, 'world', 'playerdata');
    if (!fs.existsSync(playerdataDir)) return;

    try {
      const files = fs.readdirSync(playerdataDir).filter(f => f.endsWith('.dat'));
      if (files.length > 1) {
        console.log(`[BackupManager] Found ${files.length} playerdata files in ${playerdataDir}. Checking inventory preservation...`);
        let largestFile = '';
        let maxSize = 0;
        for (const f of files) {
          const stats = fs.statSync(path.join(playerdataDir, f));
          if (stats.size > maxSize) {
            maxSize = stats.size;
            largestFile = f;
          }
        }

        if (largestFile && maxSize > 500) {
          const largestPath = path.join(playerdataDir, largestFile);
          for (const f of files) {
            if (f !== largestFile) {
              const currentPath = path.join(playerdataDir, f);
              const currentStats = fs.statSync(currentPath);
              if (currentStats.size < 500) {
                console.log(`[BackupManager] Preserving inventory from '${largestFile}' -> '${f}'`);
                fs.copyFileSync(largestPath, currentPath);
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.warn(`[BackupManager] Player inventory preservation warning:`, e.message);
    }
  }

  public async deleteBackup(serverId: string, backupName: string): Promise<void> {
    const backupDir = this.getBackupDir(serverId);
    const safeBackupName = path.basename(backupName);
    const zipPath = path.join(backupDir, safeBackupName);

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
      console.log(`[BackupManager] Deleted local backup '${safeBackupName}' for server '${serverId}'`);
    }

    try {
      await deleteRemoteBackup(serverId, safeBackupName);
    } catch (err: any) {
      console.warn(`[BackupManager] Failed to delete off-site copy of '${safeBackupName}':`, err.message);
    }
  }
}

export const backupManager = new BackupManager();

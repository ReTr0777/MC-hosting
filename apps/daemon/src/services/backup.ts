import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { getConfig } from '../config';
import { isS3Configured, uploadBackup, listRemoteBackups, downloadBackup, deleteRemoteBackup } from './s3-backup';

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  location?: 'local' | 'remote' | 'both';
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

  public async createBackup(serverId: string, customName?: string): Promise<BackupInfo> {
    const dataDir = getConfig().dataDir;
    const serverDir = path.join(dataDir, serverId);
    const backupDir = this.getBackupDir(serverId);

    if (!fs.existsSync(serverDir)) {
      throw new Error(`Server directory for '${serverId}' does not exist`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeCustomName = customName ? customName.replace(/[^a-zA-Z0-9_-]/g, '_') : 'snapshot';
    const fileName = `backup_${timestamp}_${safeCustomName}.zip`;
    const targetZipPath = path.join(backupDir, fileName);

    const zip = new AdmZip();
    const items = fs.readdirSync(serverDir);

    for (const item of items) {
      if (item === 'backups' || item === 'logs' || item === 'crash-reports' || item === '.cache' || item === '.version_mismatch_rescue') {
        continue;
      }
      const itemPath = path.join(serverDir, item);
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) {
        zip.addLocalFolder(itemPath, item);
      } else {
        zip.addLocalFile(itemPath);
      }
    }

    zip.writeZip(targetZipPath);
    const stats = fs.statSync(targetZipPath);
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

    console.log(`[BackupManager] Restoring backup '${safeBackupName}' for server '${serverId}'...`);

    // Clear existing game directories before unzipping so stale/corrupted files are removed
    const dirsToClear = ['world', 'world_nether', 'world_the_end', 'mods', 'config'];
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

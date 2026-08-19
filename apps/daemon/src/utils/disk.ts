import fs from 'fs/promises';

/**
 * Free space, in megabytes, on the filesystem holding `dir`. Null if it cannot be read.
 *
 * Null means "could not tell", never "none" — every caller treats it as permission to
 * carry on, the same rule the panel's preflight checks follow. Refusing to export or to
 * migrate because statfs failed would turn a missing number into an outage.
 */
export async function freeSpaceMb(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    // bavail, not bfree: the difference is the reserve only root can write into, and
    // nothing here runs as root on the host.
    return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

export async function diskSizeMb(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Math.floor((stats.blocks * stats.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

import fs from 'fs';
import path from 'path';

/**
 * Reconstructs a standard modern Forge/NeoForge `run.sh` when the archive's own copy is
 * missing or corrupt (e.g. a RAR entry that failed to decompress and left a 0-byte file),
 * but the installer's own `libraries/` tree — the actual dependency/launch-args payload —
 * survived intact. Modern Forge/NeoForge installers always emit an `@args` file named
 * `unix_args.txt` (Linux) / `win_args.txt` (Windows) somewhere under `libraries/net/...`,
 * alongside a `user_jvm_args.txt` at the server root; together they're everything `run.sh`
 * normally just passes straight to `java`. Rather than hardcoding the exact vendor path
 * (which varies across Forge/NeoForge versions and forks), this walks the whole `libraries/`
 * tree looking for that file by name.
 */
function findArgsFile(dir: string, serverDir: string, depth: number): string | null {
  if (depth > 8) return null;
  let items: string[];
  try {
    items = fs.readdirSync(dir);
  } catch (e) {
    return null;
  }

  for (const item of items) {
    if (item === 'unix_args.txt') {
      const p = path.join(dir, item);
      try {
        if (fs.statSync(p).size > 0) return path.relative(serverDir, p);
      } catch (e) {}
    }
  }

  for (const item of items) {
    const itemPath = path.join(dir, item);
    let isDir = false;
    try {
      isDir = fs.statSync(itemPath).isDirectory();
    } catch (e) {
      continue;
    }
    if (!isDir) continue;
    const found = findArgsFile(itemPath, serverDir, depth + 1);
    if (found) return found;
  }

  return null;
}

export function synthesizeForgeRunScript(serverDir: string, memoryMb?: number): boolean {
  const librariesDir = path.join(serverDir, 'libraries');
  if (!fs.existsSync(librariesDir)) {
    console.log(`[Forge Launch Script Recovery] No 'libraries' directory present — cannot reconstruct run.sh`);
    return false;
  }

  const argsRelPath = findArgsFile(librariesDir, serverDir, 1);

  if (!argsRelPath) {
    console.log(`[Forge Launch Script Recovery] 'libraries' directory exists but no non-empty 'unix_args.txt' was found anywhere inside it — cannot reconstruct run.sh`);
    return false;
  }

  const memFlag = memoryMb ? `-Xmx${memoryMb}M -Xms1024M ` : '';
  const script = `#!/usr/bin/env bash\njava ${memFlag}@user_jvm_args.txt @${argsRelPath.split(path.sep).join('/')} "$@"\n`;

  const runShPath = path.join(serverDir, 'run.sh');
  fs.writeFileSync(runShPath, script);
  try {
    fs.chmodSync(runShPath, 0o755);
  } catch (e) {}

  if (!fs.existsSync(path.join(serverDir, 'user_jvm_args.txt'))) {
    fs.writeFileSync(path.join(serverDir, 'user_jvm_args.txt'), '# JVM arguments\n');
  }

  console.log(`[Forge Launch Script Recovery] Reconstructed run.sh from '${argsRelPath}' (original launch script was missing or corrupt)`);
  return true;
}

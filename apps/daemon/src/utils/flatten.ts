import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const IGNORE_FILES = new Set(['craftcontrol-meta.json', 'eula.txt', 'serverpack_uploaded.tmp', '.tmp_uploads', 'no-autopause']);
const MAX_DEPTH = 6;

// Directories that are never valid "wrapper folder" candidates to search into or hoist.
// 'libraries' in particular is Forge/NeoForge's own dependency tree once the server is
// correctly laid out — Maven group IDs like `cpw.mods.securemodules` unpack to paths such
// as `libraries/cpw/mods/securemodules`, which false-positives a naive "has a mods/ folder"
// check. Treating 'libraries' (and other known internal dirs) as off-limits to recurse into
// prevents mistaking a random point inside the library tree for the real server root.
const DENY_DIR_NAMES = new Set(['libraries', 'logs', 'cache', '.mixin.out']);

// A 0-byte run.sh/run.bat is treated as "not really there" — it's typically a stray
// stub left behind by an earlier failed/retried start attempt, and trusting its mere
// existence prevents us from ever hoisting the real launch script out of a subfolder.
function hasRealFile(dir: string, name: string): boolean {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return false;
  try {
    return fs.statSync(p).size > 0;
  } catch (e) {
    return false;
  }
}

function moveContentsUp(fromDir: string, toDir: string): void {
  const items = fs.readdirSync(fromDir);
  for (const item of items) {
    const src = path.join(fromDir, item);
    const dest = path.join(toDir, item);
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory() && fs.statSync(src).isDirectory()) {
      try { execSync(`cp -rf "${src}"/* "${dest}/" 2>/dev/null || true`); } catch (e) {}
    } else {
      // An empty stub (e.g. leftover 0-byte run.sh) at the destination must not block
      // the real file from taking its place.
      if (fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) {
        try { fs.rmSync(dest, { force: true }); } catch (e) {}
      }
      try { fs.renameSync(src, dest); } catch (e) {}
    }
  }
  try { fs.rmSync(fromDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
}

function dirHasLaunchSignal(dir: string): boolean {
  return (
    hasRealFile(dir, 'run.sh') ||
    hasRealFile(dir, 'run.bat') ||
    hasRealFile(dir, 'server.jar') ||
    hasRealFile(dir, 'user_args.txt') ||
    hasRealFile(dir, 'unix_args.txt') ||
    fs.existsSync(path.join(dir, 'mods'))
  );
}

// Recursively searches for the first subdirectory (breadth-first, up to MAX_DEPTH) that
// contains a launch script/jar/mods folder, so multi-level wrapper folders (e.g. a zip
// that extracts to `ModpackName-1.0/server/run.sh`) are still found and hoisted.
function findLaunchDir(root: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;

  let items: string[];
  try {
    items = fs.readdirSync(root).filter((item) => !IGNORE_FILES.has(item));
  } catch (e) {
    return null;
  }

  const subdirs: string[] = [];
  for (const item of items) {
    if (DENY_DIR_NAMES.has(item.toLowerCase())) continue;
    const itemPath = path.join(root, item);
    let isDir = false;
    try { isDir = fs.statSync(itemPath).isDirectory(); } catch (e) { continue; }
    if (!isDir) continue;
    if (dirHasLaunchSignal(itemPath)) return itemPath;
    subdirs.push(itemPath);
  }

  for (const dir of subdirs) {
    const found = findLaunchDir(dir, depth + 1);
    if (found) return found;
  }

  return null;
}

/**
 * Smartly flattens nested root directories in server files.
 * If an archive extracted files into a subfolder (e.g. serverDir/ATM9-v1.0/run.sh, or
 * even serverDir/ATM9-v1.0/server/run.sh), this function moves the launch script/jar's
 * containing directory contents up to serverDir root.
 */
export function flattenServerDir(serverDir: string): void {
  if (!fs.existsSync(serverDir)) return;

  // Collapse chains of single-directory wrappers first (e.g. a zip that extracts into
  // one top-level folder, which itself contains only one more folder, etc).
  let guard = 0;
  while (guard++ < MAX_DEPTH) {
    const items = fs.readdirSync(serverDir).filter((item) => !IGNORE_FILES.has(item));
    if (items.length !== 1) break;
    const singleItemPath = path.join(serverDir, items[0]);
    if (!fs.statSync(singleItemPath).isDirectory()) break;
    console.log(`[Flatten] Single top-level directory '${items[0]}' detected. Flattening contents to root...`);
    moveContentsUp(singleItemPath, serverDir);
  }

  // If root already has a real (non-empty) launch script/jar, nothing more to do.
  if (dirHasLaunchSignal(serverDir)) return;

  // Otherwise, search nested subfolders (any depth) for the real launch script/jar/mods
  // and hoist that directory's contents up to root.
  const launchDir = findLaunchDir(serverDir, 1);
  if (launchDir) {
    console.log(`[Flatten] Found launch script/executable/mods inside '${path.relative(serverDir, launchDir)}'. Moving contents to root...`);
    moveContentsUp(launchDir, serverDir);
  }
}

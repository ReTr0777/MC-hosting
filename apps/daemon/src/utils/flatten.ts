import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const IGNORE_FILES = new Set(['craftcontrol-meta.json', 'eula.txt', 'serverpack_uploaded.tmp', '.tmp_uploads', 'no-autopause']);

/**
 * Smartly flattens nested root directories in server files.
 * If an archive extracted files into a subfolder (e.g. serverDir/ATM9-v1.0/run.sh),
 * this function automatically moves all contents to serverDir root.
 */
export function flattenServerDir(serverDir: string): void {
  if (!fs.existsSync(serverDir)) return;

  let items = fs.readdirSync(serverDir);
  let contentItems = items.filter((item) => !IGNORE_FILES.has(item));

  // Case 1: Only 1 non-system item in serverDir, and it is a directory
  if (contentItems.length === 1) {
    const singleItemPath = path.join(serverDir, contentItems[0]);
    if (fs.statSync(singleItemPath).isDirectory()) {
      console.log(`[Flatten] Single top-level directory '${contentItems[0]}' detected. Flattening contents to root...`);
      const subItems = fs.readdirSync(singleItemPath);
      for (const subItem of subItems) {
        const src = path.join(singleItemPath, subItem);
        const dest = path.join(serverDir, subItem);
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
          try { execSync(`cp -rf "${src}"/* "${dest}/" 2>/dev/null || true`); } catch (e) {}
        } else {
          try { fs.renameSync(src, dest); } catch (e) {}
        }
      }
      try { fs.rmSync(singleItemPath, { recursive: true, force: true }); } catch (e) {}
      items = fs.readdirSync(serverDir);
      contentItems = items.filter((item) => !IGNORE_FILES.has(item));
    }
  }

  // Case 2: Root lacks launch script/jar, but a subfolder contains run.sh, run.bat, server.jar, user_args.txt, or mods/
  const rootHasRunSh = fs.existsSync(path.join(serverDir, 'run.sh'));
  const rootHasRunBat = fs.existsSync(path.join(serverDir, 'run.bat'));
  const rootHasJar = fs.existsSync(path.join(serverDir, 'server.jar'));
  const rootHasUserArgs = fs.existsSync(path.join(serverDir, 'user_args.txt')) || fs.existsSync(path.join(serverDir, 'unix_args.txt'));

  if (!rootHasRunSh && !rootHasRunBat && !rootHasJar && !rootHasUserArgs) {
    for (const item of contentItems) {
      const itemPath = path.join(serverDir, item);
      if (fs.statSync(itemPath).isDirectory()) {
        const hasSubRunSh = fs.existsSync(path.join(itemPath, 'run.sh'));
        const hasSubRunBat = fs.existsSync(path.join(itemPath, 'run.bat'));
        const hasSubJar = fs.existsSync(path.join(itemPath, 'server.jar'));
        const hasSubUserArgs = fs.existsSync(path.join(itemPath, 'user_args.txt')) || fs.existsSync(path.join(itemPath, 'unix_args.txt'));
        const hasSubMods = fs.existsSync(path.join(itemPath, 'mods'));

        if (hasSubRunSh || hasSubRunBat || hasSubJar || hasSubUserArgs || hasSubMods) {
          console.log(`[Flatten] Found launch script/executable/mods inside subfolder '${item}'. Moving contents to root...`);
          const subItems = fs.readdirSync(itemPath);
          for (const subItem of subItems) {
            const src = path.join(itemPath, subItem);
            const dest = path.join(serverDir, subItem);
            if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
              try { execSync(`cp -rf "${src}"/* "${dest}/" 2>/dev/null || true`); } catch (e) {}
            } else {
              try { fs.renameSync(src, dest); } catch (e) {}
            }
          }
          try { fs.rmSync(itemPath, { recursive: true, force: true }); } catch (e) {}
          break;
        }
      }
    }
  }
}

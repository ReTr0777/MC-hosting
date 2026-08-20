import { compareVersions } from '@mc-manager/shared';

/**
 * Picks the `.tmod` files worth uploading out of an arbitrary selection.
 *
 * Written for one selection in particular: the whole Steam workshop folder. Steam stores
 * subscribed mods as
 *
 *   steamapps/workshop/content/1281930/<workshop id>/<tModLoader version>/<Name>.tmod
 *
 * so the files are two levels down inside numbered directories, and a folder that has seen
 * a few tModLoader updates holds several builds of the same mod side by side. Uploading
 * the lot would install older copies over newer ones depending on the order they arrived.
 *
 * So: keep only `.tmod` files, and where the same filename appears more than once, keep
 * the one from the highest version directory. `compareVersions` is the same comparison the
 * daemon version check uses, which is why "2026.06.3.6" sorts above "2026.06.3.10"
 * correctly instead of lexically.
 */
export function pickNewestTmods(files: File[]): File[] {
  const best = new Map<string, { file: File; version: string }>();

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.tmod')) continue;

    // webkitRelativePath is set only for a directory selection; a plain file picker or a
    // drag leaves it empty, in which case there is no version to compare and the file
    // stands on its own.
    const segments = (file.webkitRelativePath || '').split('/').filter(Boolean);
    const version = segments.length >= 2 ? segments[segments.length - 2] : '';

    const existing = best.get(file.name);
    if (!existing || compareVersions(version, existing.version) > 0) {
      best.set(file.name, { file, version });
    }
  }

  return Array.from(best.values()).map((entry) => entry.file);
}

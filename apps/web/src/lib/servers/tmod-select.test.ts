import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNewestTmods } from './tmod-select';

/**
 * The case this exists for: importing a Steam workshop folder that has survived a few
 * tModLoader updates.
 *
 * Steam keeps every build it has downloaded, side by side:
 *
 *   1281930/2563309347/2026.06.3.6/CalamityMod.tmod
 *   1281930/2563309347/2026.01.1.2/CalamityMod.tmod
 *
 * Uploading both installs whichever arrived last, so half the time the server silently
 * ends up on the older build — and the symptom is a mod that fails to load against the
 * pinned tModLoader, which looks like a broken mod rather than a wrong file.
 */

/** A stand-in for the browser's File, carrying only what the picker reads. */
function file(relativePath: string): File {
  const name = relativePath.split('/').pop()!;
  return { name, webkitRelativePath: relativePath } as unknown as File;
}

function names(files: File[]): string[] {
  return files.map((f) => f.name).sort();
}

test('keeps the newest build when a workshop folder holds several', () => {
  const picked = pickNewestTmods([
    file('1281930/2563309347/2026.01.1.2/CalamityMod.tmod'),
    file('1281930/2563309347/2026.06.3.6/CalamityMod.tmod'),
    file('1281930/2563309347/2025.11.9.1/CalamityMod.tmod'),
  ]);

  assert.equal(picked.length, 1, 'one mod, one file');
  assert.equal(
    (picked[0] as any).webkitRelativePath,
    '1281930/2563309347/2026.06.3.6/CalamityMod.tmod'
  );
});

test('orders builds by segment, not lexically', () => {
  // The trap: "2026.06.3.10" is lexically smaller than "2026.06.3.6", so a string compare
  // picks the older build every time once a series reaches its tenth release.
  const picked = pickNewestTmods([
    file('1281930/111/2026.06.3.6/ThoriumMod.tmod'),
    file('1281930/111/2026.06.3.10/ThoriumMod.tmod'),
  ]);

  assert.equal((picked[0] as any).webkitRelativePath, '1281930/111/2026.06.3.10/ThoriumMod.tmod');
});

test('keeps every distinct mod', () => {
  const picked = pickNewestTmods([
    file('1281930/111/2026.06.3.6/CalamityMod.tmod'),
    file('1281930/222/2026.06.3.6/ThoriumMod.tmod'),
    file('1281930/333/2026.06.3.6/MagicStorage.tmod'),
  ]);

  assert.deepEqual(names(picked), ['CalamityMod.tmod', 'MagicStorage.tmod', 'ThoriumMod.tmod']);
});

test('ignores everything that is not a .tmod', () => {
  // A real workshop folder is mostly not mods: manifests, icons, Steam bookkeeping.
  const picked = pickNewestTmods([
    file('1281930/111/2026.06.3.6/CalamityMod.tmod'),
    file('1281930/111/2026.06.3.6/icon.png'),
    file('1281930/111/workshop.json'),
    file('1281930/desktop.ini'),
  ]);

  assert.deepEqual(names(picked), ['CalamityMod.tmod']);
  assert.deepEqual(pickNewestTmods([]), []);
});

test('a plain file selection has no version path and still works', () => {
  // Dragging files in, or using the file picker, leaves webkitRelativePath empty. There is
  // no version to compare then, and the files must pass through rather than collapse.
  const picked = pickNewestTmods([file('CalamityMod.tmod'), file('ThoriumMod.tmod')]);
  assert.deepEqual(names(picked), ['CalamityMod.tmod', 'ThoriumMod.tmod']);
});

test('is case-insensitive about the extension', () => {
  assert.deepEqual(names(pickNewestTmods([file('SomeMod.TMOD')])), ['SomeMod.TMOD']);
});

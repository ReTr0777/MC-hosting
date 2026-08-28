import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isCommandMissing, runExtractors } from './archive-extract';

/**
 * The property under test: a tool is only credited with the extraction when files appear.
 * Exit codes are not evidence — a Windows node answers a missing program with the same
 * code unzip uses for "finished, with warnings" — and believing one is how an upload
 * silently produced an empty server directory.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
}

/** An execSync-shaped rejection: exit status plus whatever the shell put on stderr. */
function execFailure(status: number, stderr = ''): Error & { status: number; stderr: string } {
  return Object.assign(new Error(`Command failed`), { status, stderr });
}

const WINDOWS_MISSING = "'unzip' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";

test('cmd.exe reporting a missing program is not mistaken for unzip warnings', () => {
  assert.equal(isCommandMissing(execFailure(1, WINDOWS_MISSING)), true);
  assert.equal(isCommandMissing(execFailure(127, 'sh: 1: unrar: not found\n')), true);
  assert.equal(isCommandMissing(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), true);
  // A tool that ran and disliked the archive must stay a real failure.
  assert.equal(isCommandMissing(execFailure(9, 'unzip: cannot find or open x.zip\n')), false);
  assert.equal(isCommandMissing(execFailure(1, 'warning: stripped absolute path\n')), false);
});

test('an absent unzip hands over to the next tool instead of claiming success', () => {
  const dir = tmpDir();
  try {
    const attempts: string[] = [];
    const tried: string[] = [];
    const ok = runExtractors(
      [`unzip -q -o "a.zip" -d "${dir}"`, `tar -xf "a.zip" -C "${dir}"`],
      dir,
      0,
      'ZIP',
      attempts,
      (cmd) => {
        tried.push(cmd.split(' ')[0]);
        // Exactly what a Windows desktop node does: cmd.exe exits 1 for the missing unzip.
        if (cmd.startsWith('unzip')) throw execFailure(1, WINDOWS_MISSING);
        fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
      }
    );

    assert.equal(ok, true);
    assert.deepEqual(tried, ['unzip', 'tar']);
    assert.deepEqual(attempts, ['unzip: not installed on this node']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tool that exits clean but extracts nothing does not end the search', () => {
  const dir = tmpDir();
  try {
    const attempts: string[] = [];
    const ok = runExtractors(
      [`7z x "a.zip"`, `bsdtar -xf "a.zip"`],
      dir,
      0,
      'ZIP',
      attempts,
      (cmd) => {
        if (cmd.startsWith('bsdtar')) fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
      }
    );

    assert.equal(ok, true);
    assert.deepEqual(attempts, ['7z: reported success but extracted nothing']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unzip warnings still count when the files are actually there', () => {
  // The non-root container case: unzip could not restore ownership, but the pack is extracted.
  const dir = tmpDir();
  try {
    const attempts: string[] = [];
    const ok = runExtractors(
      [`unzip -q -o "a.zip" -d "${dir}"`],
      dir,
      0,
      'ZIP',
      attempts,
      () => {
        fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
        throw execFailure(1, 'warning: cannot set modification time\n');
      }
    );

    assert.equal(ok, true);
    assert.deepEqual(attempts, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('when nothing works, every tool is named in the reasons collected', () => {
  const dir = tmpDir();
  try {
    const attempts: string[] = [];
    const ok = runExtractors(
      [`unzip -q -o "a.zip"`, `7z x "a.zip"`],
      dir,
      0,
      'ZIP',
      attempts,
      (cmd) => {
        if (cmd.startsWith('unzip')) throw execFailure(1, WINDOWS_MISSING);
        throw execFailure(2, 'Cannot open the file as an archive\n');
      }
    );

    assert.equal(ok, false);
    assert.equal(attempts.length, 2);
    assert.match(attempts[0], /^unzip: not installed/);
    assert.match(attempts[1], /^7z: .*Cannot open the file as an archive/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry count taken before extraction is what growth is measured against', () => {
  // The real caller counts the directory while the uploaded archive is still sitting in it.
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'serverpack_uploaded.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'x');
    const before = fs.readdirSync(dir).length;

    const attempts: string[] = [];
    const ok = runExtractors([`unzip x`], dir, before, 'ZIP', attempts, () => {
      // Overwriting a file that was already there is not extraction.
      fs.writeFileSync(path.join(dir, 'eula.txt'), 'y');
    });

    assert.equal(ok, false);
    assert.deepEqual(attempts, ['unzip: reported success but extracted nothing']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionIdsOfKey } from './s3-backup';

/*
 * What this pins down is the difference between a backup being gone and a backup looking
 * gone. On Backblaze B2 a delete without a version id only inserts a delete marker, so the
 * archive underneath stays and stays billed — and ListObjectsV2 stops reporting it, which is
 * why nothing inside the panel ever noticed. Deleting by version id is the only permanent
 * delete B2 documents, and these are the two ways of getting that selection wrong.
 */

const KEY = 'craftcontrol/30677daf/backup_2026-08-23T02-00-24-758Z_auto_nightly.zip';

test('every version of the key is selected, delete markers included', () => {
  const page = {
    Versions: [
      { Key: KEY, VersionId: 'v-data' },
      { Key: KEY, VersionId: 'v-older' },
    ],
    DeleteMarkers: [{ Key: KEY, VersionId: 'v-marker' }],
  };

  // The marker has to go too: left alone once its data versions are deleted it is an orphan
  // that keeps the key listed as though something were still there.
  assert.deepEqual(versionIdsOfKey(page, KEY).sort(), ['v-data', 'v-marker', 'v-older']);
});

test('a different key sharing this one as a prefix is never touched', () => {
  // ListObjectVersions is asked for a Prefix, and B2 answers with everything that starts with
  // it. Trusting that would delete a neighbouring backup along with the condemned one.
  const page = {
    Versions: [
      { Key: KEY, VersionId: 'v-mine' },
      { Key: `${KEY}.part`, VersionId: 'v-not-mine' },
      { Key: `${KEY}x`, VersionId: 'v-also-not-mine' },
    ],
    DeleteMarkers: [{ Key: `${KEY}.part`, VersionId: 'v-marker-not-mine' }],
  };

  assert.deepEqual(versionIdsOfKey(page, KEY), ['v-mine']);
});

test('an empty page selects nothing', () => {
  assert.deepEqual(versionIdsOfKey({}, KEY), []);
  assert.deepEqual(versionIdsOfKey({ Versions: [], DeleteMarkers: [] }, KEY), []);
});

test('an entry with no version id is skipped rather than deleted blind', () => {
  // A DeleteObject carrying VersionId: undefined is exactly the unversioned delete this
  // function exists to stop making.
  const page = { Versions: [{ Key: KEY }, { Key: KEY, VersionId: 'v-real' }] };
  assert.deepEqual(versionIdsOfKey(page, KEY), ['v-real']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBackupsToPrune, BackupEntry, RetentionPolicy } from './backup-retention';

/**
 * Retention decides what gets permanently deleted, so the interesting cases are the ones where
 * it must *not* fire: no policy, a single backup, and any rule that would empty the folder.
 */

const NOW = new Date('2026-08-13T12:00:00Z');

function backup(daysAgo: number, sizeMb = 100): BackupEntry {
  return {
    name: `backup_${daysAgo}d`,
    sizeBytes: sizeMb * 1024 * 1024,
    createdAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  };
}

const NO_POLICY: RetentionPolicy = { count: null, days: null, maxTotalMb: null };

test('no policy deletes nothing', () => {
  const backups = [backup(0), backup(10), backup(400)];
  assert.deepEqual(selectBackupsToPrune(backups, NO_POLICY, NOW), []);
});

test('a count rule keeps the newest N', () => {
  const backups = [backup(0), backup(1), backup(2), backup(3)];
  assert.deepEqual(
    selectBackupsToPrune(backups, { ...NO_POLICY, count: 2 }, NOW),
    ['backup_3d', 'backup_2d']
  );
});

test('an age rule deletes by date regardless of order supplied', () => {
  const backups = [backup(40), backup(1), backup(31)];
  assert.deepEqual(
    selectBackupsToPrune(backups, { ...NO_POLICY, days: 30 }, NOW),
    ['backup_40d', 'backup_31d']
  );
});

test('rules combine — the union of what each condemns is deleted', () => {
  // "keep 3" alone would spare the 40-day-old one; the age rule takes it anyway.
  const backups = [backup(0), backup(1), backup(2), backup(40)];
  const pruned = selectBackupsToPrune(backups, { count: 3, days: 30, maxTotalMb: null }, NOW);
  assert.deepEqual(pruned, ['backup_40d']);
});

test('a size rule drops oldest until the set fits', () => {
  const backups = [backup(0, 300), backup(1, 300), backup(2, 300)];
  assert.deepEqual(
    selectBackupsToPrune(backups, { ...NO_POLICY, maxTotalMb: 700 }, NOW),
    ['backup_2d']
  );
});

test('the newest backup survives a policy that would delete everything', () => {
  // Nobody has backed up in a month and the rule says one day — leaving zero restore points
  // is never the right answer.
  const backups = [backup(30), backup(45)];
  assert.deepEqual(selectBackupsToPrune(backups, { ...NO_POLICY, days: 1 }, NOW), ['backup_45d']);
});

test('a lone backup is never pruned', () => {
  assert.deepEqual(selectBackupsToPrune([backup(999)], { ...NO_POLICY, count: 1, days: 1 }, NOW), []);
});

test('an unparseable timestamp is not treated as ancient', () => {
  const broken: BackupEntry = { name: 'weird', sizeBytes: 1024, createdAt: 'not-a-date' };
  const pruned = selectBackupsToPrune([backup(0), broken], { ...NO_POLICY, days: 7 }, NOW);
  assert.equal(pruned.includes('weird'), false);
});

test('deletions are returned oldest first', () => {
  const backups = [backup(0), backup(5), backup(10), backup(15)];
  assert.deepEqual(
    selectBackupsToPrune(backups, { ...NO_POLICY, count: 1 }, NOW),
    ['backup_15d', 'backup_10d', 'backup_5d']
  );
});

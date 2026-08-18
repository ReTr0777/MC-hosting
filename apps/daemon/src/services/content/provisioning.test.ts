import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProvisioningManager } from './provisioning';

/**
 * The panel deletes the source copy of a migrated server once the destination reports
 * it provisioned. A failure that looks like a success is the one outcome that must be
 * impossible here.
 */

test('a run that succeeded is recorded as such', async () => {
  const pm = new ProvisioningManager();
  await pm.run('srv', async () => {});

  assert.deepEqual(
    { ok: pm.lastOutcome('srv')?.ok, error: pm.lastOutcome('srv')?.error },
    { ok: true, error: undefined }
  );
});

test('a run that threw is recorded with its reason', async () => {
  const pm = new ProvisioningManager();
  // The manager re-throws, and also emits FAILED — which nothing here listens for.
  pm.on('status', () => {});

  await assert.rejects(pm.run('srv', async () => { throw new Error('no disk space'); }));

  assert.equal(pm.lastOutcome('srv')?.ok, false);
  assert.equal(pm.lastOutcome('srv')?.error, 'no disk space');
});

test('a server that has never provisioned here reports nothing', () => {
  // Distinct from a failure: the panel must not read "never ran" as "ran and worked".
  assert.equal(new ProvisioningManager().lastOutcome('srv'), undefined);
});

test('a new run clears the previous outcome while it is in flight', async () => {
  const pm = new ProvisioningManager();
  await pm.run('srv', async () => {});

  let observed: unknown = 'unset';
  await pm.run('srv', async () => {
    // Stale success from the last run would let the panel delete a source copy on the
    // strength of a provision that has not finished yet.
    observed = pm.lastOutcome('srv');
  });

  assert.equal(observed, undefined);
  assert.equal(pm.lastOutcome('srv')?.ok, true);
});

test('the lock is held during a run and released after', async () => {
  const pm = new ProvisioningManager();
  let during = false;

  await pm.run('srv', async () => { during = pm.isLocked('srv'); });

  assert.equal(during, true);
  assert.equal(pm.isLocked('srv'), false);
});

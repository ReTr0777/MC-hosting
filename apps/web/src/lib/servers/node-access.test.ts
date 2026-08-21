import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canManageNode,
  canSeeNode,
  canUseNode,
  nodeUseViolation,
  visibleNodesWhere,
} from './node-access';

const admin = { userId: 'admin-1', globalRole: 'GLOBAL_ADMIN' };
const alice = { userId: 'alice', globalRole: 'USER' };
const bob = { userId: 'bob', globalRole: 'USER' };

test('shared nodes are visible and usable by everyone', () => {
  const shared = { ownerId: null };
  assert.equal(canSeeNode(alice, shared), true);
  assert.equal(canUseNode(bob, shared), true);
  assert.equal(nodeUseViolation(bob, shared), null);
});

test('an owned node is invisible to other users', () => {
  const aliceNode = { ownerId: 'alice' };
  assert.equal(canSeeNode(alice, aliceNode), true);
  assert.equal(canSeeNode(bob, aliceNode), false);
  assert.equal(canUseNode(bob, aliceNode), false);
  assert.match(nodeUseViolation(bob, aliceNode) ?? '', /not available/);
});

test('an admin sees and uses everything', () => {
  assert.equal(canSeeNode(admin, { ownerId: 'alice' }), true);
  assert.equal(canUseNode(admin, { ownerId: 'alice' }), true);
  assert.deepEqual(visibleNodesWhere(admin), {});
});

test('the visibility filter admits shared and own nodes only', () => {
  assert.deepEqual(visibleNodesWhere(alice), {
    OR: [{ ownerId: null }, { ownerId: 'alice' }],
  });
});

test('only the owner or an admin may manage a node', () => {
  // Nobody but an admin manages the shared fleet, however visible it is.
  assert.equal(canManageNode(alice, { ownerId: null }), false);
  assert.equal(canManageNode(admin, { ownerId: null }), true);
  assert.equal(canManageNode(alice, { ownerId: 'alice' }), true);
  assert.equal(canManageNode(bob, { ownerId: 'alice' }), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceService } from './presence';

/**
 * Playtime is derived entirely from log lines, so the parsing is the feature. These cover the
 * shapes a real server actually emits — the vanilla `[HH:MM:SS] [Server thread/INFO]:` prefix, the
 * modded variants, and the disconnect wording that differs from the join wording.
 */

/** Each test uses its own server id so the shared singleton can't leak state between them. */
let seq = 0;
const freshServer = () => `test-server-${seq++}`;

test('a join followed by a leave produces one session', () => {
  const id = freshServer();

  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Notch joined the game');
  assert.deepEqual(
    presenceService.getOnline(id).map((p) => p.username),
    ['Notch']
  );

  presenceService.ingestLine(id, '[12:05:00] [Server thread/INFO]: Notch left the game');
  assert.deepEqual(presenceService.getOnline(id), []);

  const sessions = presenceService.drainSessions().filter((s) => s.serverId === id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].username, 'Notch');
  assert.ok(sessions[0].seconds >= 0);
});

test('draining hands over sessions once and then forgets them', () => {
  const id = freshServer();
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Steve joined the game');
  presenceService.ingestLine(id, '[12:00:01] [Server thread/INFO]: Steve left the game');

  assert.equal(presenceService.drainSessions().filter((s) => s.serverId === id).length, 1);
  assert.equal(presenceService.drainSessions().filter((s) => s.serverId === id).length, 0);
});

test('the UUID from the login line is attached to the session', () => {
  const id = freshServer();
  presenceService.ingestLine(
    id,
    '[12:00:00] [User Authenticator #1/INFO]: UUID of player Notch is 069a79f4-44e9-4726-a5be-fca90e38aaf5'
  );
  presenceService.ingestLine(id, '[12:00:01] [Server thread/INFO]: Notch joined the game');
  presenceService.ingestLine(id, '[12:00:02] [Server thread/INFO]: Notch left the game');

  const session = presenceService.drainSessions().find((s) => s.serverId === id);
  assert.equal(session?.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
});

test('`lost connection` closes a session just like `left the game`', () => {
  const id = freshServer();
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Alex joined the game');
  presenceService.ingestLine(id, '[12:00:03] [Server thread/INFO]: Alex lost connection: Disconnected');

  assert.deepEqual(presenceService.getOnline(id), []);
  assert.equal(presenceService.drainSessions().filter((s) => s.serverId === id).length, 1);
});

/**
 * A reattached log stream can replay a join we already saw. Resetting the clock on the duplicate
 * would silently reset the visit; keeping the original start is the less misleading of the two.
 */
test('a duplicate join does not restart the session clock', () => {
  const id = freshServer();
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Alex joined the game');
  const first = presenceService.getOnline(id)[0];

  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Alex joined the game');

  const online = presenceService.getOnline(id);
  assert.equal(online.length, 1, 'the player must not appear twice');
  assert.ok(online[0].sinceSeconds >= first.sinceSeconds);
});

/**
 * Without this, everyone online when a server goes down keeps accruing playtime for as long as it
 * stays down — a server stopped over a weekend would credit each of them 48 hours.
 */
test('stopping a server closes every open session', () => {
  const id = freshServer();
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Alex joined the game');
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Steve joined the game');

  presenceService.serverStopped(id);

  assert.deepEqual(presenceService.getOnline(id), []);
  const usernames = presenceService
    .drainSessions()
    .filter((s) => s.serverId === id)
    .map((s) => s.username)
    .sort();
  assert.deepEqual(usernames, ['Alex', 'Steve']);
});

test('a leave with no matching join is ignored', () => {
  const id = freshServer();
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: Ghost left the game');

  assert.deepEqual(presenceService.getOnline(id), []);
  assert.equal(presenceService.drainSessions().filter((s) => s.serverId === id).length, 0);
});

test('chat mentioning a join phrase does not create a session', () => {
  const id = freshServer();
  // A player typing the phrase in chat is prefixed with <name>, so the username capture would
  // otherwise pick up whatever word preceded it.
  presenceService.ingestLine(id, '[12:00:00] [Server thread/INFO]: <Alex> hey Steve joined the game earlier right');

  const online = presenceService.getOnline(id).map((p) => p.username);
  assert.deepEqual(online, [], 'chat must not register a join');
});

test('sessions are kept separate per server', () => {
  const a = freshServer();
  const b = freshServer();

  presenceService.ingestLine(a, '[12:00:00] [Server thread/INFO]: Alex joined the game');
  presenceService.ingestLine(b, '[12:00:00] [Server thread/INFO]: Steve joined the game');

  assert.deepEqual(presenceService.getOnline(a).map((p) => p.username), ['Alex']);
  assert.deepEqual(presenceService.getOnline(b).map((p) => p.username), ['Steve']);
});

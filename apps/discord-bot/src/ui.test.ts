import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCORD_CHOICE_LIMIT,
  ServerSummary,
  actionAvailable,
  decodeId,
  encodeId,
  matchServers,
  serverButtons,
  serverListEmbed,
  serverSelect,
} from './ui';

/*
 * The failures here are the ones nobody reports as bugs.
 *
 * A button offered for an action the panel will refuse produces a red message and a
 * shrug. A select menu one option over Discord's limit is rejected wholesale, so the
 * person with the most servers is the one for whom the bot does nothing at all. Neither
 * shows up in a typecheck, and neither is visible without an account that happens to be
 * in the right state.
 */

function server(over: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'Survival',
    status: 'RUNNING',
    game: 'MINECRAFT',
    label: 'FABRIC 1.20.1',
    address: 'survival.example.com',
    sleepEnabled: false,
    canManage: true,
    ...over,
  };
}

/* ── which buttons are live ────────────────────────────────────────────────────────── */

test('a sleeping server can be stopped and restarted, but not started', () => {
  /*
   * The one people get wrong. SLEEPING reads like "off", but the server is registered and
   * the next player to connect starts it — so Stop is the action someone wanting it down
   * actually needs, and greying it out would leave them no way to do that from Discord.
   */
  const s = server({ status: 'SLEEPING' });
  assert.equal(actionAvailable('stop', s), true);
  assert.equal(actionAvailable('restart', s), true);
  assert.equal(actionAvailable('start', s), false);
});

test('an offline server offers only start', () => {
  const s = server({ status: 'OFFLINE' });
  assert.equal(actionAvailable('start', s), true);
  assert.equal(actionAvailable('stop', s), false);
  assert.equal(actionAvailable('restart', s), false);
});

test('a server in ERROR can be started or stopped', () => {
  // A failed start can leave a process behind, so stop has to stay reachable; and start
  // is how someone retries after fixing whatever it was.
  const s = server({ status: 'ERROR' });
  assert.equal(actionAvailable('start', s), true);
  assert.equal(actionAvailable('stop', s), true);
});

test('an installing server offers nothing, rather than a start that would collide', () => {
  const s = server({ status: 'INSTALLING' });
  assert.equal(actionAvailable('start', s), false);
  assert.equal(actionAvailable('stop', s), false);
  assert.equal(actionAvailable('restart', s), false);
});

test('a viewer gets no live buttons whatever the status', () => {
  // The panel refuses these anyway; the point is not to offer a control that always fails.
  for (const status of ['RUNNING', 'OFFLINE', 'SLEEPING', 'ERROR']) {
    const s = server({ status, canManage: false });
    assert.equal(actionAvailable('start', s), false, status);
    assert.equal(actionAvailable('stop', s), false, status);
    assert.equal(actionAvailable('restart', s), false, status);
  }
});

test('the buttons rendered match what is available, and refresh is always live', () => {
  const row = serverButtons(server({ status: 'OFFLINE' })).toJSON();
  const byId = new Map(row.components.map((c: any) => [c.custom_id, c]));

  assert.equal(byId.get(encodeId('act', 'start', server().id))?.disabled, false);
  assert.equal(byId.get(encodeId('act', 'stop', server().id))?.disabled, true);
  // Refresh must never be disabled: it is the only way out of a card showing stale state.
  assert.notEqual(byId.get(encodeId('refresh', server().id))?.disabled, true);
});

/* ── custom ids ────────────────────────────────────────────────────────────────────── */

test('an id survives the round trip, uuid and all', () => {
  const decoded = decodeId(encodeId('act', 'start', server().id));
  assert.deepEqual(decoded, { kind: 'act', parts: ['start', server().id] });
});

test('an id this bot did not write decodes to null rather than a wrong action', () => {
  /*
   * Discord replays clicks on old messages, including ones left by another bot in the
   * same channel. Guessing at the shape of those is how a stray click becomes a stop.
   */
  assert.equal(decodeId('some-other-bot:stop:everything'), null);
  assert.equal(decodeId('cc'), null);
  assert.equal(decodeId(''), null);
});

test('a kind with no parts is still valid', () => {
  assert.deepEqual(decodeId(encodeId('list')), { kind: 'list', parts: [] });
});

/* ── Discord's hard limits ─────────────────────────────────────────────────────────── */

test('the select menu never exceeds what Discord accepts', () => {
  // Over the limit Discord rejects the whole message, so the person with the most servers
  // is the one who sees nothing at all.
  const many = Array.from({ length: 40 }, (_, i) => server({ id: `id-${i}`, name: `Server ${i}` }));
  const menu = serverSelect(many).toJSON().components[0] as any;
  assert.equal(menu.options.length, DISCORD_CHOICE_LIMIT);
});

test('an option description is never empty, even with no address and no label', () => {
  // Discord rejects a zero-length description, which would take the whole menu with it.
  const menu = serverSelect([server({ address: null, label: '' })]).toJSON().components[0] as any;
  assert.ok(menu.options[0].description.length > 0);
});

test('a long server name is truncated rather than rejected', () => {
  const menu = serverSelect([server({ name: 'x'.repeat(300) })]).toJSON().components[0] as any;
  assert.ok(menu.options[0].label.length <= 100);
});

test('the list embed says how many it did not show', () => {
  const many = Array.from({ length: 30 }, (_, i) => server({ id: `id-${i}`, name: `Server ${i}` }));
  const description = serverListEmbed(many).toJSON().description ?? '';
  assert.match(description, /5 more/);
});

/* ── finding a server by name ──────────────────────────────────────────────────────── */

test('matching is on any part of the name, not just the start', () => {
  // Names get prefixed with a season or a pack, and the memorable half is rarely first.
  const servers = [server({ id: '1', name: 'SMP - Create' }), server({ id: '2', name: 'Vanilla 1.21' })];
  assert.deepEqual(matchServers(servers, 'create').map((s) => s.id), ['1']);
  assert.deepEqual(matchServers(servers, 'CREATE').map((s) => s.id), ['1']);
});

test('an empty query offers everything, capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => server({ id: `id-${i}`, name: `Server ${i}` }));
  assert.equal(matchServers(many, '').length, DISCORD_CHOICE_LIMIT);
  assert.equal(matchServers(many, '   ').length, DISCORD_CHOICE_LIMIT);
});

test('no match is an empty list, not everything', () => {
  // Falling back to the full list would put an unrelated server under the cursor of
  // someone who typed a name carefully.
  assert.deepEqual(matchServers([server()], 'nothing-like-it'), []);
});

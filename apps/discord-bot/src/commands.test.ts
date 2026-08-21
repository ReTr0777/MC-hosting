import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import { globalCommands, guildCommands, installUrl } from './commands';

/*
 * These pin down the two fields that decide where the bot can be used at all. Neither is
 * visible in a typecheck, and the failure they guard against is not an error: a command
 * registered without a user-install integration type registers perfectly happily and then
 * simply never appears in a DM, which reads as Discord being slow rather than as a bug.
 */

test('every command can be installed to an account as well as to a server', () => {
  for (const c of globalCommands()) {
    assert.deepEqual(
      c.integration_types,
      [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
      `${c.name} must be installable both ways`
    );
  }
});

test('every command works in a guild, in the bot DM and in a private channel', () => {
  // Leaving one out is how a command goes missing in DMs specifically — the context people
  // are most likely to reach for a user install from.
  for (const c of globalCommands()) {
    assert.deepEqual(
      c.contexts,
      [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
      `${c.name} must be usable everywhere`
    );
  }
});

test('the guild copy carries neither field, which Discord would reject', () => {
  for (const c of guildCommands()) {
    assert.equal('integration_types' in c, false, `${c.name} must not declare an integration type`);
    assert.equal('contexts' in c, false, `${c.name} must not declare contexts`);
  }
});

test('the two registrations describe the same commands', () => {
  // The guild copy exists only to skip the propagation wait. If it drifts, development is
  // done against a bot that behaves differently from the one everyone else has.
  assert.deepEqual(
    guildCommands().map((c) => c.name).sort(),
    globalCommands().map((c) => c.name).sort()
  );
});

test('a user install asks for commands only, and for no server', () => {
  const url = new URL(installUrl('123', 'user'));
  assert.equal(url.searchParams.get('integration_type'), '1');
  assert.equal(url.searchParams.get('scope'), 'applications.commands');
  // A `bot` scope here would make Discord demand a server to add it to, defeating the point.
  assert.equal(url.searchParams.get('permissions'), null);
  assert.equal(url.searchParams.get('client_id'), '123');
});

test('a server install asks for no permissions', () => {
  // The bot only ever replies to interactions; any permission bit here would be one an
  // admin has to grant for nothing.
  const url = new URL(installUrl('123', 'guild'));
  assert.equal(url.searchParams.get('integration_type'), '0');
  assert.equal(url.searchParams.get('permissions'), '0');
  assert.match(url.searchParams.get('scope') ?? '', /applications\.commands/);
});

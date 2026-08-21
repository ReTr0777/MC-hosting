import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { linkAccount, listServers, getServer, runAction, isNotLinkedError, ServerSummary } from './api';
import { globalCommands, guildCommands, installUrl } from './commands';
import {
  Action,
  decodeId,
  matchServers,
  serverButtons,
  serverCardEmbed,
  serverListEmbed,
  serverSelect,
} from './ui';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('[discord-bot] DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required. See .env.example.');
  process.exit(1);
}
if (!process.env.DISCORD_BOT_SECRET) {
  console.error('[discord-bot] DISCORD_BOT_SECRET is required and must match the web panel\'s value.');
  process.exit(1);
}

/*
 * Every reply is ephemeral. It keeps a channel from filling with status dumps, and it is
 * also what makes the buttons safe: an ephemeral message exists only for the person who
 * ran the command, so nobody else can press the Stop button on it.
 *
 * It is also a hard requirement of being installable to a user account: in a guild the app
 * was never added to, Discord only permits an ephemeral response.
 */
const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/**
 * Registers globally, always.
 *
 * Global is the only scope that can carry an integration type, so it is the only scope a
 * user install can come from — registering solely to a guild, as this used to, is what
 * would confine the bot to that one server. A guild registration is still done alongside
 * when DISCORD_GUILD_ID is set, purely so changes show up there without the wait; it
 * shadows the global copy of the same name rather than duplicating it.
 */
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(TOKEN!);
  const global = globalCommands();

  await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: global });
  console.log(
    `[discord-bot] Registered ${global.length} commands globally, installable to a server or to an account.` +
      ' A first global registration can take up to an hour to appear.'
  );

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID), { body: guildCommands() });
    console.log(`[discord-bot] Also registered to guild ${GUILD_ID} for immediate availability.`);
  }

  console.log(`[discord-bot] Add to your account: ${installUrl(CLIENT_ID!, 'user')}`);
  console.log(`[discord-bot] Add to a server:     ${installUrl(CLIENT_ID!, 'guild')}`);
}

function friendlyError(err: any): string {
  if (isNotLinkedError(err)) {
    return 'Your Discord account is not linked yet. Open the CraftControl panel, click **Link Discord**, then run `/link <code>` with the code it gives you.';
  }
  return err?.message || 'Something went wrong.';
}

type Repliable = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

/** Replaces the current reply with one server's card and its buttons. */
async function showServer(interaction: Repliable, server: ServerSummary, banner?: string) {
  await interaction.editReply({
    content: banner ?? null,
    embeds: [serverCardEmbed(server)],
    components: [serverButtons(server)],
  });
}

/** Replaces the current reply with the picker. */
async function showList(interaction: Repliable, servers: ServerSummary[]) {
  if (servers.length === 0) {
    await interaction.editReply({
      content:
        'No servers are visible to your linked account. If you expect to see one, ask its owner to add you on the panel\'s Access tab.',
      embeds: [],
      components: [],
    });
    return;
  }
  await interaction.editReply({
    content: null,
    embeds: [serverListEmbed(servers)],
    components: [serverSelect(servers)],
  });
}

/* ── commands ──────────────────────────────────────────────────────────────────────── */

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('CraftControl')
    .setColor(0x5865f2)
    .setDescription('Manage your game servers without leaving Discord. Every reply is visible only to you.')
    .addFields(
      { name: '/servers', value: 'List everything you can see, then pick one to manage with buttons. Start here.' },
      { name: '/server <name>', value: 'Jump straight to one server\'s controls. The name autocompletes.' },
      { name: '/start · /stop · /restart <name>', value: 'Do it in one step, if you already know which server.' },
      {
        name: '/link <code>',
        value: 'Connect this Discord account to your panel account. Get the code from **Link Discord** in the panel.',
      },
      {
        name: '/install',
        value: 'Add the bot to your own account, so these commands work in any server and in DMs.',
      }
    )
    .setFooter({ text: 'A sleeping server does not need starting — it wakes when someone joins.' });
  await interaction.editReply({ embeds: [embed] });
}

/**
 * The install links, from inside Discord.
 *
 * Someone who wants the bot in a second server, or in a DM at three in the morning, should
 * not have to go and find a URL somebody pasted once. Adding it to an account needs no
 * permissions and no server admin — which is the part people do not expect.
 */
async function handleInstall(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('Use CraftControl everywhere')
    .setColor(0x5865f2)
    .setDescription(
      'The commands are the same either way, and both can be done at once. Your panel account is what decides which servers you see, so a fresh install still only shows you what is yours.'
    )
    .addFields(
      {
        name: 'Add to your account',
        value:
          `[Install for yourself](${installUrl(CLIENT_ID!, 'user')})
` +
          'Works in DMs, group DMs and every server you are in — including ones where you cannot add bots. Nobody else in those servers sees the bot or your replies.',
      },
      {
        name: 'Add to a server',
        value:
          `[Install to a server](${installUrl(CLIENT_ID!, 'guild')})
` +
          'Requires Manage Server there. Everyone in the server can then use the commands, each seeing only their own servers.',
      }
    )
    .setFooter({ text: 'Freshly installed commands can take a minute to appear. Reloading Discord helps.' });
  await interaction.editReply({ embeds: [embed] });
}

async function handleLink(interaction: ChatInputCommandInteraction) {
  const code = interaction.options.getString('code', true);
  try {
    const result = await linkAccount(code, interaction.user.id);
    await interaction.editReply(
      `✅ Linked to panel account **${result.username}**. Try \`/servers\` — that is the only command you need to remember.`
    );
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

async function handleServers(interaction: ChatInputCommandInteraction) {
  try {
    await showList(interaction, await listServers(interaction.user.id));
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

/**
 * Resolves what someone typed or picked into one server.
 *
 * Autocomplete sends the id back as the option's value, so the normal path is an exact
 * id. A typed name is matched case-insensitively, and an ambiguous one is reported rather
 * than resolved — picking the first of two servers called "survival" and stopping it is
 * the kind of help nobody wants.
 */
async function resolveServer(
  discordUserId: string,
  typed: string
): Promise<{ server: ServerSummary } | { error: string }> {
  const servers = await listServers(discordUserId);

  const byId = servers.find((s) => s.id === typed);
  if (byId) return { server: byId };

  const byName = servers.filter((s) => s.name.toLowerCase() === typed.trim().toLowerCase());
  if (byName.length === 1) return { server: byName[0] };
  if (byName.length > 1) {
    return { error: `More than one server is called "${typed}". Use \`/servers\` and pick the one you mean.` };
  }

  const near = matchServers(servers, typed).slice(0, 5);
  if (near.length > 0) {
    return { error: `No server called "${typed}". Did you mean: ${near.map((s) => `**${s.name}**`).join(', ')}?` };
  }
  return { error: `No server called "${typed}" is visible to your account.` };
}

async function handleServerCard(interaction: ChatInputCommandInteraction) {
  try {
    const resolved = await resolveServer(interaction.user.id, interaction.options.getString('server', true));
    if ('error' in resolved) {
      await interaction.editReply(`❌ ${resolved.error}`);
      return;
    }
    await showServer(interaction, resolved.server);
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

async function handleLifecycleCommand(interaction: ChatInputCommandInteraction, action: Action) {
  try {
    const resolved = await resolveServer(interaction.user.id, interaction.options.getString('server', true));
    if ('error' in resolved) {
      await interaction.editReply(`❌ ${resolved.error}`);
      return;
    }
    await applyAction(interaction, resolved.server.id, action);
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

/**
 * Runs an action, then re-renders the card from the panel's own view of the server rather
 * than from what the action returned. The two disagree often enough to matter: a start is
 * recorded as RUNNING the moment the command is accepted, while a large modpack takes
 * minutes to actually come up.
 */
async function applyAction(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  serverId: string,
  action: Action
) {
  let banner: string;
  try {
    const result = await runAction(interaction.user.id, { serverId }, action);
    banner = `✅ ${action.charAt(0).toUpperCase() + action.slice(1)} sent to **${result.serverName}**.`;
  } catch (err: any) {
    banner = `❌ ${friendlyError(err)}`;
  }

  /*
   * The card is re-rendered on failure too. A refused action leaves the server exactly as
   * it was, and taking the buttons away would make a permission error look as though the
   * server had gone.
   */
  const fresh = await getServer(interaction.user.id, serverId).catch(() => null);
  if (fresh) {
    await showServer(interaction, fresh, banner);
  } else {
    await interaction.editReply({ content: banner, embeds: [], components: [] });
  }
}

/* ── components ────────────────────────────────────────────────────────────────────── */

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const typed = interaction.options.getFocused();
  try {
    const servers = await listServers(interaction.user.id);
    await interaction.respond(
      matchServers(servers, typed).map((s) => ({
        name: `${s.name} — ${s.status.toLowerCase()}`.slice(0, 100),
        value: s.id,
      }))
    );
  } catch {
    /*
     * Autocomplete has no way to show an error: Discord's only options are choices or
     * silence. An unlinked user gets nothing here and the real explanation when they run
     * the command, which is the right place for it.
     */
    await interaction.respond([]).catch(() => {});
  }
}

async function handleComponent(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const decoded = decodeId(interaction.customId);
  if (!decoded) return;

  // Edits the existing ephemeral message in place, so the card updates where it already is.
  await interaction.deferUpdate();

  const gone = { content: '❌ That server no longer exists.', embeds: [], components: [] };

  try {
    if (decoded.kind === 'pick' && interaction.isStringSelectMenu()) {
      const server = await getServer(interaction.user.id, interaction.values[0]);
      if (!server) return void (await interaction.editReply(gone));
      return void (await showServer(interaction, server));
    }

    if (decoded.kind === 'list') {
      return void (await showList(interaction, await listServers(interaction.user.id)));
    }

    if (decoded.kind === 'refresh') {
      const server = await getServer(interaction.user.id, decoded.parts[0]);
      if (!server) return void (await interaction.editReply(gone));
      return void (await showServer(interaction, server));
    }

    if (decoded.kind === 'act' && interaction.isButton()) {
      const [action, serverId] = decoded.parts;
      await applyAction(interaction, serverId, action as Action);
    }
  } catch (err: any) {
    await interaction
      .editReply({ content: `❌ ${friendlyError(err)}`, embeds: [], components: [] })
      .catch(() => {});
  }
}

/* ── wiring ────────────────────────────────────────────────────────────────────────── */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`[discord-bot] Logged in as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isButton() || interaction.isStringSelectMenu()) return await handleComponent(interaction);
    if (!interaction.isChatInputCommand()) return;

    /*
     * Deferred before anything touches the panel. Discord discards an interaction that is
     * not acknowledged within three seconds, and a cold panel can take longer than that
     * just to list servers.
     */
    await interaction.deferReply(EPHEMERAL);

    switch (interaction.commandName) {
      case 'help':
        return await handleHelp(interaction);
      case 'install':
        return await handleInstall(interaction);
      case 'link':
        return await handleLink(interaction);
      case 'servers':
        return await handleServers(interaction);
      case 'server':
        return await handleServerCard(interaction);
      case 'start':
        return await handleLifecycleCommand(interaction, 'start');
      case 'stop':
        return await handleLifecycleCommand(interaction, 'stop');
      case 'restart':
        return await handleLifecycleCommand(interaction, 'restart');
    }
  } catch (err: any) {
    console.error('[discord-bot] Unhandled error:', err);
    if (interaction.isAutocomplete() || !interaction.isRepliable()) return;
    const content = '❌ An unexpected error occurred.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content, ...EPHEMERAL }).catch(() => {});
    }
  }
});

async function main() {
  await registerCommands();
  await client.login(TOKEN);
}

main().catch((err) => {
  console.error('[discord-bot] Fatal startup error:', err);
  process.exit(1);
});

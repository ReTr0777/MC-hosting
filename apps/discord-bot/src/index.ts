import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { linkAccount, listServers, runAction, isNotLinkedError, ServerSummary } from './api';

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

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your CraftControl panel account')
    .addStringOption((opt) => opt.setName('code').setDescription('Code from the panel\'s "Link Discord" button').setRequired(true)),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the status of your servers'),
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start a server')
    .addStringOption((opt) => opt.setName('server').setDescription('Server name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop a server')
    .addStringOption((opt) => opt.setName('server').setDescription('Server name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart a server')
    .addStringOption((opt) => opt.setName('server').setDescription('Server name').setRequired(true)),
].map((c) => c.toJSON());

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(TOKEN!);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID) : Routes.applicationCommands(CLIENT_ID!);
  await rest.put(route, { body: commands });
  console.log(`[discord-bot] Registered ${commands.length} slash commands${GUILD_ID ? ` to guild ${GUILD_ID}` : ' globally (may take up to an hour to propagate)'}.`);
}

const STATUS_EMOJI: Record<string, string> = {
  RUNNING: '🟢',
  STARTING: '🟡',
  STOPPING: '🟠',
  OFFLINE: '⚪',
  ERROR: '🔴',
  INSTALLING: '🔵',
  SLEEPING: '🌙',
};

function friendlyError(err: any): string {
  if (isNotLinkedError(err)) {
    return 'Your Discord account isn\'t linked yet. Click "Link Discord" in the CraftControl panel, then run `/link <code>`.';
  }
  return err?.message || 'Something went wrong.';
}

async function handleLink(interaction: ChatInputCommandInteraction) {
  const code = interaction.options.getString('code', true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await linkAccount(code, interaction.user.id);
    await interaction.editReply(`✅ Linked to panel account **${result.username}**. You can now use \`/status\`, \`/start\`, \`/stop\`, and \`/restart\`.`);
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const { servers } = await listServers(interaction.user.id);
    if (servers.length === 0) {
      await interaction.editReply('No servers are visible to your linked account.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('CraftControl — Your Servers')
      .setColor(0x3ba55d)
      .setDescription(
        servers
          .map((s: ServerSummary) => `${STATUS_EMOJI[s.status] || '⚪'} **${s.name}** — ${s.status} (${s.serverType} ${s.mcVersion})`)
          .join('\n')
      );
    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

async function handleLifecycleAction(interaction: ChatInputCommandInteraction, action: 'start' | 'stop' | 'restart') {
  const serverName = interaction.options.getString('server', true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await runAction(interaction.user.id, serverName, action);
    await interaction.editReply(`✅ ${result.message} — status: **${result.status}**`);
  } catch (err: any) {
    await interaction.editReply(`❌ ${friendlyError(err)}`);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`[discord-bot] Logged in as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'link':
        return await handleLink(interaction);
      case 'status':
        return await handleStatus(interaction);
      case 'start':
        return await handleLifecycleAction(interaction, 'start');
      case 'stop':
        return await handleLifecycleAction(interaction, 'stop');
      case 'restart':
        return await handleLifecycleAction(interaction, 'restart');
    }
  } catch (err: any) {
    console.error(`[discord-bot] Unhandled error in /${interaction.commandName}:`, err);
    const payload = { content: '❌ An unexpected error occurred.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
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

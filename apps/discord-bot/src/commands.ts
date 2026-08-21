/**
 * The command definitions, and where the bot can be used.
 *
 * Kept out of index.ts so the shape of what gets registered is testable without a token:
 * the difference between a bot that works in one server and one that works everywhere is
 * two fields on this JSON, and getting them wrong fails at registration time or, worse,
 * registers fine and simply never appears outside the home guild.
 */
import {
  ApplicationIntegrationType,
  InteractionContextType,
  RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';

/**
 * Installable both onto a server and onto a person.
 *
 * A user install belongs to the account rather than to a guild, so the commands travel with
 * whoever installed them — into DMs, group DMs and any server they are in, including ones
 * where nobody could add a bot. That is the point: the person who needs to restart a server
 * is rarely sitting in the guild the bot happens to live in.
 */
export const INTEGRATION_TYPES = [
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
];

/**
 * Every context Discord has: a guild channel, the bot's own DM, and a group DM or the DM of
 * an unrelated user. Omitting one is how a command ends up mysteriously missing in DMs.
 *
 * Safe here only because every reply this bot sends is ephemeral. In a guild where the app
 * is not installed, Discord requires that anyway — a user-installed app cannot post visibly
 * into someone else's server.
 */
export const CONTEXTS = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];

/**
 * The server option, shared by the commands that take one.
 *
 * Autocompleted, which is the whole difference between this bot and one you have to
 * remember exact names for. Typing a name still works; nobody has to.
 */
const serverOption = (opt: any) =>
  opt.setName('server').setDescription('Which server').setRequired(true).setAutocomplete(true);

function build(): SlashCommandBuilder[] {
  return [
    new SlashCommandBuilder()
      .setName('servers')
      .setDescription('List your servers and manage them with buttons'),
    new SlashCommandBuilder()
      .setName('server')
      .setDescription('Open one server, with buttons to start, stop or restart it')
      .addStringOption(serverOption),
    new SlashCommandBuilder()
      .setName('start')
      .setDescription('Start a server')
      .addStringOption(serverOption),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop a server')
      .addStringOption(serverOption),
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Restart a server')
      .addStringOption(serverOption),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your CraftControl panel account')
      .addStringOption((opt) =>
        opt.setName('code').setDescription('Code from the panel\'s "Link Discord" button').setRequired(true)
      ),
    new SlashCommandBuilder().setName('install').setDescription('Get the link to add this bot to your own account'),
    new SlashCommandBuilder().setName('help').setDescription('What this bot can do'),
  ] as SlashCommandBuilder[];
}

/**
 * The commands as registered globally — the only scope that can carry an integration type,
 * and therefore the only scope a user install can come from.
 */
export function globalCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return build().map((c) =>
    c.setIntegrationTypes(INTEGRATION_TYPES).setContexts(CONTEXTS).toJSON()
  );
}

/**
 * The same commands for a single guild, used only to get changes visible immediately during
 * development — a global registration can take up to an hour to propagate.
 *
 * Both fields are stripped: a guild command is by definition installed to that guild, and
 * Discord rejects the payload rather than ignoring them. A guild registration shadows the
 * global command of the same name inside that guild, so the two do not appear twice.
 */
export function guildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return build().map((c) => {
    const { integration_types, contexts, ...rest } = c.toJSON() as RESTPostAPIApplicationCommandsJSONBody &
      Partial<Record<'integration_types' | 'contexts', unknown>>;
    return rest as RESTPostAPIApplicationCommandsJSONBody;
  });
}

/**
 * Where to install the bot.
 *
 * `user` needs no permissions and no server: it attaches the commands to the account of
 * whoever opens it, which is what makes the bot usable in a DM. `guild` is the classic
 * install and is what puts the bot in a server's member list.
 */
export function installUrl(clientId: string, kind: 'user' | 'guild'): string {
  const params = new URLSearchParams({ client_id: clientId });
  if (kind === 'user') {
    params.set('integration_type', String(ApplicationIntegrationType.UserInstall));
    params.set('scope', 'applications.commands');
  } else {
    params.set('integration_type', String(ApplicationIntegrationType.GuildInstall));
    params.set('scope', 'bot applications.commands');
    // The bot reads and writes nothing on its own; everything it does is a reply to an
    // interaction, which needs no permission bits at all.
    params.set('permissions', '0');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

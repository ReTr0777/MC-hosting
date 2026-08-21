/**
 * Presentation for the bot: what a server looks like in Discord, and which controls are
 * offered for it.
 *
 * Kept apart from index.ts because it is the part with rules in it. Whether Stop is
 * offered for a SLEEPING server is a decision, not a rendering detail, and it is much
 * easier to be sure of it here than by clicking through Discord.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

export interface ServerSummary {
  id: string;
  name: string;
  status: string;
  game: string;
  /** Pre-rendered by the panel, which knows whether this is a Minecraft or Terraria row. */
  label: string;
  address: string | null;
  sleepEnabled: boolean;
  canManage: boolean;
}

export type Action = 'start' | 'stop' | 'restart';

/** Discord refuses more than 25 options in a select menu, and 25 choices in autocomplete. */
export const DISCORD_CHOICE_LIMIT = 25;

const STATUS_EMOJI: Record<string, string> = {
  RUNNING: '🟢',
  STARTING: '🟡',
  STOPPING: '🟠',
  OFFLINE: '⚪',
  ERROR: '🔴',
  INSTALLING: '🔵',
  SLEEPING: '🌙',
};

export function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] || '⚪';
}

/**
 * The one line of explanation a status deserves. SLEEPING is the case that needs it: a
 * server showing as not running, which players can nonetheless join, is alarming without
 * a word about why.
 */
export function statusNote(server: ServerSummary): string | null {
  switch (server.status) {
    case 'SLEEPING':
      return 'Asleep to save resources. It wakes by itself when someone joins — starting it by hand is optional.';
    case 'INSTALLING':
      return 'Still installing. It will start on its own when that finishes.';
    case 'ERROR':
      return 'Last start failed. The panel\'s console tab has the reason.';
    case 'STARTING':
      return 'Starting. Large modpacks can take several minutes.';
    default:
      return null;
  }
}

/*
 * Which actions make sense right now.
 *
 * The point of disabling rather than hiding is that the control keeps its position, so a
 * card does not reshuffle its buttons under a cursor between refreshes.
 */
export function actionAvailable(action: Action, server: ServerSummary): boolean {
  if (!server.canManage) return false;
  const s = server.status;
  switch (action) {
    case 'start':
      return s === 'OFFLINE' || s === 'ERROR';
    case 'stop':
      // SLEEPING counts as up: the server is registered and a joining player starts it,
      // so stopping is exactly what someone wanting it *down* needs.
      return s === 'RUNNING' || s === 'SLEEPING' || s === 'STARTING' || s === 'ERROR';
    case 'restart':
      return s === 'RUNNING' || s === 'SLEEPING';
  }
}

/* ── custom ids ────────────────────────────────────────────────────────────────────── */

/**
 * `cc:` prefixed and `:` separated. Discord hands the id back as an opaque string on every
 * click, including clicks on messages left over from a previous version of the bot, so
 * decoding never assumes the shape is one it wrote.
 */
export function encodeId(kind: string, ...parts: string[]): string {
  return ['cc', kind, ...parts].join(':');
}

export function decodeId(customId: string): { kind: string; parts: string[] } | null {
  const bits = customId.split(':');
  if (bits.length < 2 || bits[0] !== 'cc') return null;
  return { kind: bits[1], parts: bits.slice(2) };
}

/* ── components ────────────────────────────────────────────────────────────────────── */

export function serverButtons(server: ServerSummary): ActionRowBuilder<ButtonBuilder> {
  const button = (action: Action, label: string, style: ButtonStyle, emoji: string) =>
    new ButtonBuilder()
      .setCustomId(encodeId('act', action, server.id))
      .setLabel(label)
      .setStyle(style)
      .setEmoji(emoji)
      .setDisabled(!actionAvailable(action, server));

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('start', 'Start', ButtonStyle.Success, '▶️'),
    button('stop', 'Stop', ButtonStyle.Danger, '⏹️'),
    button('restart', 'Restart', ButtonStyle.Primary, '🔄'),
    new ButtonBuilder()
      .setCustomId(encodeId('refresh', server.id))
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔃'),
    new ButtonBuilder()
      .setCustomId(encodeId('list'))
      .setLabel('All servers')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋')
  );
}

export function serverSelect(servers: ServerSummary[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeId('pick'))
    .setPlaceholder('Pick a server to manage')
    .addOptions(
      servers.slice(0, DISCORD_CHOICE_LIMIT).map((s) => ({
        label: s.name.slice(0, 100),
        // Discord rejects an empty description, and a server with no address has none.
        description: (s.address ?? s.label).slice(0, 100) || s.status,
        value: s.id,
        emoji: statusEmoji(s.status),
      }))
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/* ── embeds ────────────────────────────────────────────────────────────────────────── */

const COLOR_BY_STATUS: Record<string, number> = {
  RUNNING: 0x3ba55d,
  SLEEPING: 0x5865f2,
  STARTING: 0xfaa61a,
  STOPPING: 0xfaa61a,
  INSTALLING: 0x5865f2,
  ERROR: 0xed4245,
  OFFLINE: 0x747f8d,
};

export function serverListEmbed(servers: ServerSummary[]): EmbedBuilder {
  const lines = servers
    .slice(0, DISCORD_CHOICE_LIMIT)
    .map((s) => `${statusEmoji(s.status)} **${s.name}** — ${s.status.toLowerCase()} · ${s.label}`);

  if (servers.length > DISCORD_CHOICE_LIMIT) {
    lines.push(`\n…and ${servers.length - DISCORD_CHOICE_LIMIT} more. Use \`/server\` to reach one by name.`);
  }

  return new EmbedBuilder()
    .setTitle('Your servers')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Pick one below to start, stop or restart it.' });
}

export function serverCardEmbed(server: ServerSummary): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(server.status)} ${server.name}`)
    .setColor(COLOR_BY_STATUS[server.status] ?? 0x747f8d)
    .addFields(
      { name: 'Status', value: server.status.toLowerCase(), inline: true },
      { name: 'Running', value: server.label || '—', inline: true }
    );

  if (server.address) {
    embed.addFields({ name: 'Address', value: `\`${server.address}\``, inline: true });
  }

  const note = statusNote(server);
  if (note) embed.setDescription(note);

  if (!server.canManage) {
    embed.setFooter({ text: 'You have view-only access to this server.' });
  }

  return embed;
}

/**
 * Autocomplete matching. Substring rather than prefix, because server names get prefixed
 * with a pack or a season ("SMP - Create") and the part people remember is rarely the
 * first word.
 */
export function matchServers(servers: ServerSummary[], query: string): ServerSummary[] {
  const q = query.trim().toLowerCase();
  const matched = q ? servers.filter((s) => s.name.toLowerCase().includes(q)) : servers;
  return matched.slice(0, DISCORD_CHOICE_LIMIT);
}

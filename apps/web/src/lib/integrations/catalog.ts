export interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  /** 'mod' = Fabric/Forge loader dir (mods/), 'plugin' = Bukkit/Paper dir (plugins/), 'both' ships as either */
  category: 'mod' | 'plugin' | 'both';
  matchPatterns: RegExp[];
  /** Which panel component renders when this card is expanded. 'none' = still a placeholder. */
  panelType: 'voicechat' | 'yaml' | 'commands' | 'info' | 'none';
  /** Key into YAML_CONFIGS / COMMAND_ACTIONS for 'yaml' / 'commands' panels. */
  panelKey?: string;
  /** Static text shown for 'info' panels. */
  infoText?: string;
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'voicechat',
    name: 'Simple Voice Chat',
    description: 'Proximity voice chat for players, with adjustable range and group channels.',
    category: 'mod',
    matchPatterns: [/simple.?voice.?chat/i, /^voicechat[-_]/i],
    panelType: 'voicechat',
  },
  {
    id: 'geyser',
    name: 'Geyser',
    description: 'Lets Bedrock Edition players (mobile, console) join this Java server.',
    category: 'mod',
    matchPatterns: [/geyser/i],
    panelType: 'yaml',
    panelKey: 'geyser',
  },
  {
    id: 'floodgate',
    name: 'Floodgate',
    description: 'Lets Bedrock players join without a linked Java account, paired with Geyser.',
    category: 'mod',
    matchPatterns: [/floodgate/i],
    panelType: 'yaml',
    panelKey: 'floodgate',
  },
  {
    id: 'luckperms',
    name: 'LuckPerms',
    description: 'Permission groups and per-player overrides.',
    category: 'plugin',
    matchPatterns: [/luckperms/i],
    panelType: 'commands',
    panelKey: 'luckperms',
  },
  {
    id: 'dynmap',
    name: 'Dynmap',
    description: 'Live, browsable web map of the world.',
    category: 'plugin',
    matchPatterns: [/dynmap/i],
    panelType: 'yaml',
    panelKey: 'dynmap',
  },
  {
    id: 'chunky',
    name: 'Chunky',
    description: 'Pre-generates world chunks so players never hit generation lag at the border.',
    category: 'both',
    matchPatterns: [/chunky/i],
    panelType: 'commands',
    panelKey: 'chunky',
  },
  {
    id: 'essentials',
    name: 'EssentialsX',
    description: 'Homes, warps, kits, and core quality-of-life commands.',
    category: 'plugin',
    matchPatterns: [/essentialsx?/i],
    panelType: 'yaml',
    panelKey: 'essentials',
  },
  {
    id: 'vault',
    name: 'Vault',
    description: 'Shared economy/permissions API most other plugins hook into.',
    category: 'plugin',
    matchPatterns: [/vault/i],
    panelType: 'info',
    infoText: "Vault has no settings of its own — it's a compatibility layer other plugins (like EssentialsX) call into for economy and permissions. Nothing to configure here.",
  },
  {
    id: 'spark',
    name: 'Spark',
    description: 'Performance profiler — captures flame graphs to diagnose lag spikes.',
    category: 'both',
    matchPatterns: [/spark/i],
    panelType: 'commands',
    panelKey: 'spark',
  },
  {
    id: 'multiverse',
    name: 'Multiverse-Core',
    description: 'Manage multiple worlds with independent gamerules and borders.',
    category: 'plugin',
    matchPatterns: [/multiverse-core/i],
    panelType: 'yaml',
    panelKey: 'multiverse',
  },
];

/** Fabric/Forge-family loaders read the mods/ folder; Paper/Purpur read plugins/. */
export function integrationCategoryForServerType(serverType: string): 'mod' | 'plugin' | null {
  if (['FABRIC', 'FORGE', 'MODRINTH', 'CURSEFORGE'].includes(serverType)) return 'mod';
  if (['PAPER', 'PURPUR'].includes(serverType)) return 'plugin';
  return null;
}

/** Whether a card should be shown at all for this server's loader family. */
export function isIntegrationVisible(def: IntegrationDef, serverType: string): boolean {
  const loaderCategory = integrationCategoryForServerType(serverType);
  if (!loaderCategory) return false;
  return def.category === 'both' || def.category === loaderCategory;
}

export function isIntegrationInstalled(def: IntegrationDef, mods: string[], plugins: string[]): boolean {
  // A couple of these (Spark, Chunky) ship as both a Fabric/Forge mod and a Bukkit plugin,
  // so detection checks both dirs — `category` only decides which cards are shown for a
  // given server's loader, not where the jar is expected to live.
  const jars = [...mods, ...plugins];
  return jars.some((fileName) => def.matchPatterns.some((pattern) => pattern.test(fileName)));
}

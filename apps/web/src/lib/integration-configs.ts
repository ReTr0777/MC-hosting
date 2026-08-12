export interface YamlFieldDef {
  dotPath: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: string[];
  default: string;
  hint?: string;
}

export interface YamlConfigDef {
  /** Tried in order; first one that exists on disk is used. */
  candidatePaths: string[];
  fields: YamlFieldDef[];
  /** Used to create the file from scratch when none of candidatePaths exist yet. */
  defaultTemplate: string;
}

export const YAML_CONFIGS: Record<string, YamlConfigDef> = {
  geyser: {
    candidatePaths: [
      'config/Geyser-Fabric/config.yml',
      'config/Geyser-Forge/config.yml',
      'config/Geyser-NeoForge/config.yml',
      'plugins/Geyser-Spigot/config.yml',
    ],
    fields: [
      { dotPath: 'bedrock.port', label: 'Bedrock Port', type: 'number', default: '19132' },
      { dotPath: 'bedrock.motd1', label: 'MOTD Line 1', type: 'text', default: 'Geyser' },
      { dotPath: 'bedrock.motd2', label: 'MOTD Line 2', type: 'text', default: 'Another Geyser server.' },
      { dotPath: 'remote.auth-type', label: 'Auth Type', type: 'select', options: ['online', 'offline', 'floodgate'], default: 'floodgate' },
      { dotPath: 'max-players', label: 'Max Bedrock Players', type: 'number', default: '100' },
      { dotPath: 'debug-mode', label: 'Debug Mode', type: 'boolean', default: 'false' },
    ],
    defaultTemplate: [
      'bedrock:',
      '  port: 19132',
      '  motd1: "Geyser"',
      '  motd2: "Another Geyser server."',
      'remote:',
      '  address: auto',
      '  port: 25565',
      '  auth-type: floodgate',
      'max-players: 100',
      'debug-mode: false',
      '',
    ].join('\n'),
  },
  floodgate: {
    candidatePaths: ['config/floodgate/config.yml', 'plugins/floodgate/config.yml'],
    fields: [
      { dotPath: 'username-prefix', label: 'Bedrock Username Prefix', type: 'text', default: '.', hint: 'Prepended to Bedrock player names so they never collide with a Java username.' },
      { dotPath: 'replace-spaces', label: 'Replace Spaces in Usernames', type: 'boolean', default: 'true' },
    ],
    defaultTemplate: ['username-prefix: "."', 'replace-spaces: true', ''].join('\n'),
  },
  dynmap: {
    candidatePaths: ['plugins/dynmap/configuration.txt'],
    fields: [
      { dotPath: 'webserver-port', label: 'Web Map Port', type: 'number', default: '8123' },
      { dotPath: 'disable-webserver', label: 'Disable Built-in Web Server', type: 'boolean', default: 'false', hint: 'Turn on only if you\'re reverse-proxying the map yourself.' },
    ],
    defaultTemplate: ['webserver-port: 8123', 'disable-webserver: false', ''].join('\n'),
  },
  essentials: {
    candidatePaths: ['plugins/Essentials/config.yml'],
    fields: [
      { dotPath: 'currency-symbol', label: 'Currency Symbol', type: 'text', default: '$' },
      { dotPath: 'starting-balance', label: 'Starting Balance', type: 'number', default: '0' },
      { dotPath: 'allow-silent-join-quit', label: 'Allow Silent Join/Quit', type: 'boolean', default: 'false' },
    ],
    defaultTemplate: ['currency-symbol: "$"', 'starting-balance: 0', 'allow-silent-join-quit: false', ''].join('\n'),
  },
  multiverse: {
    candidatePaths: ['plugins/Multiverse-Core/config.yml'],
    fields: [
      { dotPath: 'enforceaccess', label: 'Enforce World Access Permissions', type: 'boolean', default: 'false' },
      { dotPath: 'teleportintercept', label: 'Intercept Cross-World Teleports', type: 'boolean', default: 'true' },
      { dotPath: 'firstspawnworld', label: 'First Spawn World', type: 'text', default: 'world' },
    ],
    defaultTemplate: ['enforceaccess: false', 'teleportintercept: true', 'firstspawnworld: world', ''].join('\n'),
  },
};

export interface CommandActionParam {
  name: string;
  label: string;
  type: 'text' | 'number';
  default: string;
}

export interface CommandActionDef {
  id: string;
  label: string;
  /** {{param}} placeholders substituted from param values before sending. */
  commandTemplate: string;
  params?: CommandActionParam[];
  description?: string;
}

export const COMMAND_ACTIONS: Record<string, CommandActionDef[]> = {
  luckperms: [
    {
      id: 'set-group',
      label: 'Set Player Group',
      commandTemplate: 'lp user {{player}} parent set {{group}}',
      params: [
        { name: 'player', label: 'Player name', type: 'text', default: '' },
        { name: 'group', label: 'Group', type: 'text', default: 'default' },
      ],
    },
    {
      id: 'add-perm',
      label: 'Grant Permission to Group',
      commandTemplate: 'lp group {{group}} permission set {{node}} true',
      params: [
        { name: 'group', label: 'Group', type: 'text', default: 'default' },
        { name: 'node', label: 'Permission node', type: 'text', default: '' },
      ],
    },
    {
      id: 'sync',
      label: 'Reload / Sync Data',
      commandTemplate: 'lp sync',
    },
  ],
  chunky: [
    {
      id: 'start',
      label: 'Start Pre-generation',
      commandTemplate: 'chunky start {{world}} square 0 0 {{radius}}',
      params: [
        { name: 'world', label: 'World name', type: 'text', default: 'world' },
        { name: 'radius', label: 'Radius (blocks)', type: 'number', default: '5000' },
      ],
      description: 'Generates a square region centered on 0,0. Check console output for progress.',
    },
    { id: 'pause', label: 'Pause', commandTemplate: 'chunky pause' },
    { id: 'continue', label: 'Continue', commandTemplate: 'chunky continue' },
    { id: 'cancel', label: 'Cancel', commandTemplate: 'chunky cancel' },
  ],
  spark: [
    {
      id: 'profiler-start',
      label: 'Start Profiler',
      commandTemplate: 'spark profiler start --timeout {{timeout}}',
      params: [{ name: 'timeout', label: 'Auto-stop after (seconds)', type: 'number', default: '300' }],
      description: 'A shareable flame-graph link is posted to console/spark.lucko.me when it stops.',
    },
    { id: 'profiler-stop', label: 'Stop Profiler', commandTemplate: 'spark profiler stop' },
    { id: 'health', label: 'Health Report', commandTemplate: 'spark health', description: 'Posts a TPS/CPU/memory snapshot to console.' },
  ],
};

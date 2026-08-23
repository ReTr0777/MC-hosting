import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Game, DEFAULT_ENABLED_GAMES, parseGameList } from '@mc-manager/shared';

export interface DaemonConfig {
  port: number;
  apiKey: string;
  dataDir: string;
  hostDataDir?: string;
  dockerSocket?: string;
  setupPassword?: string;
  frpServerAddr?: string;
  frpServerPort?: number;
  frpToken?: string;
  /**
   * Port on the tunnel server that maps back to this node's API, or unset for no
   * such mapping.
   *
   * The panel reaches a node by connecting *to* it, which a node behind NAT — a
   * machine at someone else's house, or on the far side of a second router — cannot
   * accept. Its tunnel connection runs the other way and already works, so this
   * publishes the API along it: the panel then registers the node as
   * <tunnel server>:<this port> instead of an address it could never route to.
   */
  frpApiRemotePort?: number;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3Prefix?: string;
  s3RetainLocal?: boolean;
  /** Games this node will host. See DEFAULT_ENABLED_GAMES for why it is never empty. */
  enabledGames?: Game[];
  /**
   * Most RAM, in MB, this node will hand out to servers, or 0/unset for the whole machine.
   *
   * A node on somebody's own desktop shares the machine with whatever else they do with
   * it. Reported to the panel as the node's capacity, so placements are refused against
   * this number rather than against the RAM the hardware happens to have.
   */
  maxMemoryMb?: number;
  /**
   * Same, in logical processors (threads) — the unit Docker's --cpus takes, and the unit
   * a server's cpuLimit is already in. Not physical cores. 0/unset means all of them.
   */
  maxCpus?: number;
}

const dataBaseDir = process.env.DAEMON_DATA_DIR ? path.dirname(process.env.DAEMON_DATA_DIR) : path.join(process.cwd(), 'data');

const defaultConfig: DaemonConfig = {
  port: parseInt(process.env.DAEMON_PORT || '3500', 10),
  apiKey: process.env.DAEMON_API_KEY || 'default-daemon-secret-key',
  dataDir: process.env.DAEMON_DATA_DIR || path.join(process.cwd(), 'data', 'servers'),
  hostDataDir: process.env.HOST_DATA_DIR || undefined,
  frpServerAddr: process.env.FRP_SERVER_ADDR || '',
  frpServerPort: parseInt(process.env.FRP_SERVER_PORT || '7000', 10),
  frpToken: process.env.FRP_TOKEN || '',
  // FRP_DAEMON_API_PORT predates the config field and still works, so a Docker node
  // set up through env vars keeps behaving as it did.
  frpApiRemotePort: process.env.FRP_DAEMON_API_PORT ? parseInt(process.env.FRP_DAEMON_API_PORT, 10) : undefined,
  s3RetainLocal: true,
  enabledGames: [...DEFAULT_ENABLED_GAMES],
  maxMemoryMb: parseInt(process.env.DAEMON_MAX_MEMORY_MB || '0', 10) || 0,
  maxCpus: parseFloat(process.env.DAEMON_MAX_CPUS || '0') || 0,
};

let loadedConfig: DaemonConfig = { ...defaultConfig };

const configPath = path.join(dataBaseDir, 'config.json');

export function loadConfig(): DaemonConfig {
  if (!fs.existsSync(dataBaseDir)) {
    fs.mkdirSync(dataBaseDir, { recursive: true });
  }

  let needsSave = false;

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      loadedConfig = { ...defaultConfig, ...parsed };
    } catch (err) {
      console.warn('[Daemon] Failed to read config.json, using defaults.');
    }
  }

  // config.json may predate this setting, or have been hand-edited. Either way the
  // node must still advertise something runnable, so fall back rather than trust it.
  loadedConfig.enabledGames = parseGameList(loadedConfig.enabledGames) ?? [...DEFAULT_ENABLED_GAMES];

  // Ensure a setup password exists
  if (!loadedConfig.setupPassword) {
    loadedConfig.setupPassword = crypto.randomBytes(8).toString('hex');
    console.log('\n======================================================');
    console.log('🎉 INITIAL DAEMON SETUP 🎉');
    console.log(`Access the Setup GUI at: http://<daemon-ip>:${loadedConfig.port}/`);
    console.log(`Your Setup Password is:  ${loadedConfig.setupPassword}`);
    console.log('======================================================\n');
    needsSave = true;
  }

  if (needsSave) {
    saveConfig(loadedConfig);
  }

  return loadedConfig;
}

export function saveConfig(newConfig: Partial<DaemonConfig>) {
  loadedConfig = { ...loadedConfig, ...newConfig };

  // Never let a save leave the node advertising an empty or invalid list — that would
  // make it invisible to the panel's node picker with no obvious way to recover.
  loadedConfig.enabledGames = parseGameList(loadedConfig.enabledGames) ?? [...DEFAULT_ENABLED_GAMES];


  if (!fs.existsSync(dataBaseDir)) {
    fs.mkdirSync(dataBaseDir, { recursive: true });
  }
  
  fs.writeFileSync(configPath, JSON.stringify(loadedConfig, null, 2));
}

export function getConfig(): DaemonConfig {
  return loadedConfig;
}

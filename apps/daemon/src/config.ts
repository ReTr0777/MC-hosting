import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface DaemonConfig {
  port: number;
  apiKey: string;
  dataDir: string;
  dockerSocket?: string;
  setupPassword?: string;
  frpServerAddr?: string;
  frpServerPort?: number;
  frpToken?: string;
}

const dataBaseDir = process.env.DAEMON_DATA_DIR ? path.dirname(process.env.DAEMON_DATA_DIR) : path.join(process.cwd(), 'data');

const defaultConfig: DaemonConfig = {
  port: parseInt(process.env.DAEMON_PORT || '3500', 10),
  apiKey: process.env.DAEMON_API_KEY || 'default-daemon-secret-key',
  dataDir: process.env.DAEMON_DATA_DIR || path.join(process.cwd(), 'data', 'servers'),
  frpServerAddr: process.env.FRP_SERVER_ADDR || '',
  frpServerPort: parseInt(process.env.FRP_SERVER_PORT || '7000', 10),
  frpToken: process.env.FRP_TOKEN || '',
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
  
  if (!fs.existsSync(dataBaseDir)) {
    fs.mkdirSync(dataBaseDir, { recursive: true });
  }
  
  fs.writeFileSync(configPath, JSON.stringify(loadedConfig, null, 2));
}

export function getConfig(): DaemonConfig {
  return loadedConfig;
}

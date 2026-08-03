import fs from 'fs';
import path from 'path';

export interface DaemonConfig {
  port: number;
  apiKey: string;
  dataDir: string;
  dockerSocket?: string;
}

const defaultConfig: DaemonConfig = {
  port: parseInt(process.env.DAEMON_PORT || '3500', 10),
  apiKey: process.env.DAEMON_API_KEY || 'default-daemon-secret-key',
  dataDir: process.env.DAEMON_DATA_DIR || path.join(process.cwd(), 'data', 'servers'),
};

let loadedConfig: DaemonConfig = { ...defaultConfig };

export function loadConfig(): DaemonConfig {
  const configPath = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      loadedConfig = { ...defaultConfig, ...parsed };
    } catch (err) {
      console.warn('[Daemon] Failed to read config.json, using defaults or env vars.');
    }
  }
  return loadedConfig;
}

export function getConfig(): DaemonConfig {
  return loadedConfig;
}

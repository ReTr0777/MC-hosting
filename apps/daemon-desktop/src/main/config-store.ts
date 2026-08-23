import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { EnrollResult, NodeConfig } from '../shared-types';

/*
 * The desktop app and the daemon share one config.json.
 *
 * The daemon derives its config directory from DAEMON_DATA_DIR (see
 * apps/daemon/src/config.ts): it takes the *parent* of that path. We point it at
 * <userData>/data/servers so the file lands at <userData>/data/config.json,
 * somewhere writable — the install directory under Program Files is not.
 */

export class ConfigStore {
  readonly dataRoot: string;
  readonly serversDir: string;
  private readonly configPath: string;

  constructor(userDataPath: string) {
    this.dataRoot = path.join(userDataPath, 'data');
    this.serversDir = path.join(this.dataRoot, 'servers');
    this.configPath = path.join(this.dataRoot, 'config.json');
  }

  private readRaw(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Missing or corrupt both mean "no usable settings yet"; defaults take over.
      return {};
    }
  }

  /** Creates the data directories and a strong API key the first time the app runs. */
  ensureInitialised(): void {
    fs.mkdirSync(this.serversDir, { recursive: true });

    const raw = this.readRaw();
    const patch: Record<string, unknown> = {};

    // The daemon's built-in fallback is a well-known string. A node reachable on the
    // LAN with a guessable bearer token is worth fixing before it ever starts.
    const key = raw.apiKey;
    if (typeof key !== 'string' || key.length === 0 || key === 'default-daemon-secret-key') {
      patch.apiKey = crypto.randomBytes(32).toString('hex');
    }
    if (typeof raw.setupPassword !== 'string' || !raw.setupPassword) {
      patch.setupPassword = crypto.randomBytes(8).toString('hex');
    }
    if (typeof raw.port !== 'number') patch.port = 3500;
    if (!Array.isArray(raw.enabledGames) || raw.enabledGames.length === 0) {
      patch.enabledGames = ['MINECRAFT'];
    }

    /*
     * dataDir is absolute in config.json so the daemon writes servers next to the config
     * rather than beside whatever the working directory happens to be.
     *
     * Only written when it is missing. It used to be forced back to the default on every
     * launch, which meant a node whose owner moved their servers to another drive was
     * quietly moved back to the system disk the next time the app started — with the data
     * still on the other drive, so every server looked empty.
     */
    if (typeof raw.dataDir !== 'string' || !raw.dataDir) patch.dataDir = this.serversDir;

    if (Object.keys(patch).length > 0) this.write(patch);
  }

  read(): NodeConfig {
    const raw = this.readRaw();
    return {
      port: typeof raw.port === 'number' ? raw.port : 3500,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      // Written by enrollment only. Empty means this node has never joined a panel from
      // in here — it may still be registered by hand, which the app cannot know about.
      panelUrl: typeof raw.panelUrl === 'string' ? raw.panelUrl : '',
      nodeName: typeof raw.nodeName === 'string' ? raw.nodeName : '',
      // Default on. Every server is a container, so an installed node that comes up without
      // Docker is a node that cannot do the one thing it exists for.
      startDockerWithApp: raw.startDockerWithApp !== false,
      /*
       * Absent on a fresh install, which is what opens the wizard. Also treated as done
       * when the node has already joined a panel, so an app that upgraded into this
       * version does not greet an established node with a setup it finished long ago.
       */
      setupCompleted: raw.setupCompleted === true || typeof raw.panelUrl === 'string' && !!raw.panelUrl,
      frpServerAddr: typeof raw.frpServerAddr === 'string' ? raw.frpServerAddr : '',
      frpServerPort: typeof raw.frpServerPort === 'number' ? raw.frpServerPort : 7000,
      frpToken: typeof raw.frpToken === 'string' ? raw.frpToken : '',
      // 0 means "not published": the UI shows an empty field, and the daemon leaves
      // the API off the tunnel entirely.
      frpApiRemotePort: typeof raw.frpApiRemotePort === 'number' ? raw.frpApiRemotePort : 0,
      enabledGames: Array.isArray(raw.enabledGames) ? (raw.enabledGames as string[]) : ['MINECRAFT'],
      dataDir: typeof raw.dataDir === 'string' && raw.dataDir ? raw.dataDir : this.serversDir,
      // 0 means "no limit": the node offers whatever the machine has. See
      // apps/daemon/src/services/allowance.ts, which is what actually enforces these.
      maxMemoryMb: typeof raw.maxMemoryMb === 'number' ? raw.maxMemoryMb : 0,
      maxCpuCores: typeof raw.maxCpuCores === 'number' ? raw.maxCpuCores : 0,
    };
  }

  write(patch: Record<string, unknown>): void {
    const merged = { ...this.readRaw(), ...patch };
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2));
  }

  /**
   * Applies a config file exported by the web panel.
   *
   * Validated field by field rather than merged wholesale: the file arrives from
   * outside the app, and a malformed or hand-edited one must fail with something an
   * operator can act on instead of quietly writing nonsense into config.json.
   */
  importFile(filePath: string): { nodeName: string | null; panelUrl: string | null } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw new Error('That file is not valid JSON. Export a fresh copy from the panel.');
    }

    const doc = parsed as Record<string, any>;
    if (doc?.format !== 'mc-hosting-node-config') {
      throw new Error('That is not a node config file. Export one from the panel: Nodes → the download icon.');
    }
    if (typeof doc.version !== 'number' || doc.version > 1) {
      throw new Error(`This config was made by a newer panel (format v${doc.version}). Update this app first.`);
    }

    const incoming = doc.node ?? {};
    const patch: Record<string, unknown> = {};

    /*
     * Accept whatever key the panel issued, however short.
     *
     * This used to demand eight characters, which the panel never enforced when the
     * node was registered — so a node created with a short key exported a file this
     * app refused, and the import failed with a message implying the file was corrupt.
     * Import is the wrong place to enforce a password policy: the panel is the
     * authority on what a node's key is, and refusing to match it only guarantees the
     * two disagree.
     *
     * The one value still rejected is the daemon's built-in fallback, because it is a
     * published constant rather than a secret anybody chose.
     */
    const incomingKey = typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : '';
    if (!incomingKey) {
      throw new Error('That config has no daemon key in it. Export a fresh copy from the panel.');
    }
    if (incomingKey === 'default-daemon-secret-key') {
      throw new Error(
        'That config carries the placeholder daemon key, which every node ships with and is not a secret. ' +
          'Set a real key on the node in the panel, then export again.'
      );
    }
    patch.apiKey = incomingKey;

    if (typeof incoming.port === 'number' && incoming.port > 0 && incoming.port < 65536) {
      patch.port = incoming.port;
    }

    if (Array.isArray(incoming.enabledGames)) {
      const games = incoming.enabledGames.filter((g: unknown) => typeof g === 'string');
      // An empty list would hide the node from the panel's picker entirely, so keep
      // whatever is already configured rather than accepting nothing.
      if (games.length > 0) patch.enabledGames = games;
    }

    // Optional: present only when the exporting panel knows the tunnel settings.
    const tunnel = doc.tunnel ?? {};
    if (typeof tunnel.serverAddr === 'string') patch.frpServerAddr = tunnel.serverAddr;
    if (typeof tunnel.serverPort === 'number') patch.frpServerPort = tunnel.serverPort;
    if (typeof tunnel.token === 'string') patch.frpToken = tunnel.token;

    this.write(patch);

    return {
      nodeName: typeof doc.panel?.nodeName === 'string' ? doc.panel.nodeName : null,
      panelUrl: typeof doc.panel?.url === 'string' ? doc.panel.url : null,
    };
  }

  /**
   * Writes what the panel decided when this machine enrolled.
   *
   * The tunnel half is the part that matters: the panel has already recorded the node at
   * the address it published, and until these settings are saved and the agent restarted,
   * that address answers nothing. Absent tunnel settings mean the panel reached this
   * machine directly, and whatever tunnel config is here already is left alone rather than
   * cleared — a node may be tunnelling its game ports regardless of how its API is reached.
   */
  applyEnrollment(result: EnrollResult): void {
    const patch: Record<string, unknown> = {
      panelUrl: result.panelUrl,
      nodeName: result.node.name,
      nodeId: result.node.id,
      enrolledAt: new Date().toISOString(),
    };

    if (result.tunnel) {
      patch.frpServerAddr = result.tunnel.serverAddr;
      patch.frpServerPort = result.tunnel.serverPort;
      patch.frpToken = result.tunnel.token;
      patch.frpApiRemotePort = result.tunnel.apiRemotePort;
    }

    this.write(patch);
  }

  regenerateApiKey(): string {
    const apiKey = crypto.randomBytes(32).toString('hex');
    this.write({ apiKey });
    return apiKey;
  }
}

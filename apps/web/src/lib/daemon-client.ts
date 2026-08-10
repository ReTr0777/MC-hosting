import { CreateServerContainerDto, DaemonHealthDto } from '@mc-manager/shared';

export interface NodeCredentials {
  host: string;
  port: number;
  apiKey: string;
}

export class DaemonClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(node: NodeCredentials) {
    const protocol = node.port === 443 ? 'https' : 'http';
    this.baseUrl = `${protocol}://${node.host}:${node.port}/api/v1`;
    this.apiKey = node.apiKey;
  }

  public async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...options.headers,
    };

    let res: Response;
    try {
      // 5-second connection timeout prevents proxy 504 gateway timeouts
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      res = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timeoutId);
    } catch (fetchErr: any) {
      if (fetchErr.name === 'AbortError') {
        throw new Error(`Connection timed out after 5s connecting to daemon worker node at ${this.baseUrl}. Check if daemon is running.`);
      }
      throw new Error(`Cannot connect to daemon worker node at ${this.baseUrl}: ${fetchErr.message}`);
    }

    let data: any = {};
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      throw new Error(`Daemon node returned invalid non-JSON response (HTTP ${res.status}). Snippet: ${text.substring(0, 120)}`);
    }

    if (!res.ok) {
      const msg = data.details ? `${data.error}: ${data.details}` : (data.error || `Daemon error HTTP ${res.status}`);
      throw new Error(msg);
    }

    return data as T;
  }

  async getHealth(): Promise<DaemonHealthDto> {
    return this.request<DaemonHealthDto>('/system/health');
  }

  async createServer(dto: CreateServerContainerDto): Promise<{ message: string; containerId: string }> {
    return this.request<{ message: string; containerId: string }>('/servers/create', {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  }

  async startServer(containerId: string, meta?: any): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}/start`, {
      method: 'POST',
      body: meta ? JSON.stringify(meta) : undefined,
    });
  }

  async stopServer(containerId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}/stop`, {
      method: 'POST',
    });
  }

  async gracefulStopServer(containerId: string, countdown: number): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}/stop?countdown=${countdown}`, {
      method: 'POST',
    });
  }

  async restartServer(containerId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}/restart`, {
      method: 'POST',
    });
  }

  async killServer(containerId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}/kill`, {
      method: 'POST',
    });
  }

  async deleteServer(containerId: string, deleteData = false, serverId?: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}`, {
      method: 'DELETE',
      body: JSON.stringify({ deleteData, serverId }),
    });
  }

  // File Manager API Methods
  async listFiles(serverId: string, path: string = ''): Promise<{ currentPath: string; files: any[] }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request<{ currentPath: string; files: any[] }>(`/servers/${serverId}/files/list${query}`);
  }

  async readFile(serverId: string, path: string): Promise<{ path: string; content: string; size: number; modifiedAt: string }> {
    return this.request<{ path: string; content: string; size: number; modifiedAt: string }>(`/servers/${serverId}/files/read?path=${encodeURIComponent(path)}`);
  }

  async writeFile(serverId: string, path: string, content: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/servers/${serverId}/files/write`, {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
  }

  async createFolder(serverId: string, path: string, name: string): Promise<{ success: boolean; folderPath: string }> {
    return this.request<{ success: boolean; folderPath: string }>(`/servers/${serverId}/files/create-folder`, {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    });
  }

  async renameFile(serverId: string, oldPath: string, newPath: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/servers/${serverId}/files/rename`, {
      method: 'POST',
      body: JSON.stringify({ oldPath, newPath }),
    });
  }

  async deleteFile(serverId: string, path: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/servers/${serverId}/files/delete`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  async uploadPack(serverId: string, pack: Buffer): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${serverId}/upload-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(pack),
    });
  }

  async uploadChunk(serverId: string, uploadId: string, chunkIndex: number, chunk: Buffer): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/servers/${serverId}/upload-chunk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Id': uploadId,
        'X-Chunk-Index': String(chunkIndex),
      },
      body: new Uint8Array(chunk),
    });
  }

  async completeChunkedUpload(serverId: string, uploadId: string, fileName: string, totalChunks: number, isServerpack = true, targetPath = '', isFullImport = false): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${serverId}/upload-complete`, {
      method: 'POST',
      body: JSON.stringify({ uploadId, fileName, totalChunks, isServerpack, targetPath, isFullImport }),
    });
  }

  // Mod Management API Methods
  async searchMods(serverId: string, query: string, options: { gameVersion?: string; loader?: string; limit?: number; offset?: number; projectType?: 'mod' | 'modpack' } = {}): Promise<{ hits: any[]; total_hits: number }> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (options.gameVersion) params.set('gameVersion', options.gameVersion);
    if (options.loader) params.set('loader', options.loader);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.projectType) params.set('projectType', options.projectType);
    
    return this.request<{ hits: any[]; total_hits: number }>(`/servers/${serverId}/mods/search?${params}`);
  }

  async getModVersions(serverId: string, projectId: string, options: { gameVersion?: string; loader?: string } = {}): Promise<{ versions: any[] }> {
    const params = new URLSearchParams();
    if (options.gameVersion) params.set('gameVersion', options.gameVersion);
    if (options.loader) params.set('loader', options.loader);
    
    return this.request<{ versions: any[] }>(`/servers/${serverId}/mods/versions/${projectId}?${params}`);
  }

  async sendCommand(serverId: string, command: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/servers/${serverId}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  }

  async broadcast(serverId: string, message: string): Promise<{ success: boolean; message: string }> {
    const payload = JSON.stringify({ text: `[Broadcast] ${message}`, color: 'yellow', bold: true });
    return this.sendCommand(serverId, `tellraw @a ${payload}`);
  }

  async installMod(serverId: string, projectId: string, versionId: string, fileUrl: string, fileName: string, createBackup: boolean = true): Promise<{ success: boolean; message: string; fileName: string }> {
    return this.request<{ success: boolean; message: string; fileName: string }>(`/servers/${serverId}/mods/install`, {
      method: 'POST',
      body: JSON.stringify({ projectId, versionId, fileUrl, fileName, createBackup }),
    });
  }

  async listMods(serverId: string): Promise<{ mods: any[] }> {
    return this.request<{ mods: any[] }>(`/servers/${serverId}/mods/list`);
  }

  async uninstallMod(serverId: string, fileName: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/servers/${serverId}/mods/${fileName}`, {
      method: 'DELETE',
    });
  }

  // Whitelist API Methods
  async getWhitelist(serverId: string): Promise<WhitelistSnapshot> {
    return this.request<WhitelistSnapshot>(`/servers/${serverId}/whitelist`);
  }

  async whitelistAction(serverId: string, action: WhitelistAction, username?: string): Promise<{ success: boolean; live: boolean; message: string }> {
    return this.request<{ success: boolean; live: boolean; message: string }>(`/servers/${serverId}/whitelist`, {
      method: 'POST',
      body: JSON.stringify({ action, username }),
    });
  }

  // Ban list API Methods
  async getBans(serverId: string): Promise<BanSnapshot> {
    return this.request<BanSnapshot>(`/servers/${serverId}/bans`);
  }

  async banAction(serverId: string, action: BanAction, username: string, reason?: string): Promise<{ success: boolean; live: boolean; message: string }> {
    return this.request<{ success: boolean; live: boolean; message: string }>(`/servers/${serverId}/bans`, {
      method: 'POST',
      body: JSON.stringify({ action, username, reason }),
    });
  }
}

export type WhitelistAction = 'add' | 'remove' | 'on' | 'off' | 'reload';

export interface WhitelistEntry {
  uuid: string;
  name: string;
  isOp: boolean;
  opLevel: number | null;
  online: boolean;
  avatarUrl: string;
}

export interface WhitelistSnapshot {
  enabled: boolean;
  enforce: boolean;
  onlineMode: boolean;
  live: boolean;
  count: number;
  entries: WhitelistEntry[];
  unlistedOps: string[];
}

export type BanAction = 'ban' | 'unban';

export interface BanEntry {
  uuid: string;
  name: string;
  reason: string;
  source: string;
  created: string | null;
  expires: string | null;
  avatarUrl: string;
}

export interface BanSnapshot {
  live: boolean;
  count: number;
  entries: BanEntry[];
}

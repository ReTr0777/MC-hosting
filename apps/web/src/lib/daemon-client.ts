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
}

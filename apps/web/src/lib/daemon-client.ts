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

    const res = await fetch(url, { ...options, headers });
    const data = await res.json();

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

  async startServer(containerId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/servers/${containerId}/start`, {
      method: 'POST',
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
}

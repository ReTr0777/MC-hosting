import { ServerType, ExecutionMode } from './enums';

export interface CreateServerContainerDto {
  serverId: string;
  serverType: ServerType;
  mcVersion: string;
  modpackSlug?: string;
  modId?: number;
  fileId?: number;
  serverPort: number;
  /** Host port published to BlueMap's web server (container port 8100). */
  bluemapPort?: number;
  memoryMb: number;
  cpuLimit: number;
  eulaAccepted: boolean;
  isMigration?: boolean;
  executionMode?: ExecutionMode;
}

export interface DaemonHealthDto {
  status: string;
  uptime: number;
  cpuUsage: number;
  memoryUsage: {
    used: number;
    total: number;
    free: number;
    swapUsed: number;
    swapTotal: number;
  };
  dockerAvailable: boolean;
  diskUsage?: {
    used: number;
    total: number;
    free: number;
    usedPercent: number;
    mount: string;
  }[];
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  osInfo?: {
    platform: string;
    distro: string;
    arch: string;
    kernel: string;
    hostname: string;
  };
  cpuTemp?: number | null;
  networkInterfaces?: {
    iface: string;
    ip4: string;
    speed: number;
    rx_sec: number;
    tx_sec: number;
  }[];
}

export interface WsAuthPayload {
  auth: string;
}

export interface WsIncomingMessage {
  event: 'auth' | 'command';
  data?: string;
  auth?: string;
}

export interface WsOutgoingMessage {
  event: 'authenticated' | 'log' | 'status' | 'error';
  data?: string;
  message?: string;
}

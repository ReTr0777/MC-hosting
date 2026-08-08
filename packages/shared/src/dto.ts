import { ServerType, ExecutionMode } from './enums';

export interface CreateServerContainerDto {
  serverId: string;
  serverType: ServerType;
  mcVersion: string;
  modpackSlug?: string;
  modId?: number;
  fileId?: number;
  serverPort: number;
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
  };
  dockerAvailable: boolean;
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

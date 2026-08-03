import EventEmitter from 'events';

export const STATUS = {
  PROVISIONING: 'PROVISIONING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  FAILED: 'FAILED',
};

export interface LogEntry {
  type: 'daemon' | 'container';
  line: string;
  ts: number;
}

export class ProvisioningManager extends EventEmitter {
  private locks = new Set<string>();
  private logBuffers = new Map<string, LogEntry[]>();

  isLocked(serverId: string): boolean {
    return this.locks.has(serverId);
  }

  emitLog(serverId: string, type: 'daemon' | 'container', line: string) {
    const entry: LogEntry = { type, line, ts: Date.now() };
    if (!this.logBuffers.has(serverId)) {
      this.logBuffers.set(serverId, []);
    }
    const buf = this.logBuffers.get(serverId)!;
    buf.push(entry);
    if (buf.length > 500) {
      buf.shift();
    }
    this.emit('log', { serverId, ...entry });
  }

  getLogBuffer(serverId: string): LogEntry[] {
    return this.logBuffers.get(serverId) || [];
  }

  clearLogBuffer(serverId: string) {
    this.logBuffers.delete(serverId);
  }

  async run(serverId: string, task: () => Promise<void>): Promise<void> {
    if (this.locks.has(serverId)) {
      console.warn(`[Provisioning] Server ${serverId} is already locked for provisioning.`);
      return;
    }
    this.locks.add(serverId);
    try {
      await task();
    } catch (err: any) {
      console.error(`[Provisioning Error] Server ${serverId} provisioning failed:`, err.message);
      this.emitLog(serverId, 'daemon', `[Daemon Error] ${err.message}`);
      this.emit('status', { serverId, status: STATUS.FAILED, error: err.message });
      throw err;
    } finally {
      this.locks.delete(serverId);
    }
  }
}

export const provisioningManager = new ProvisioningManager();

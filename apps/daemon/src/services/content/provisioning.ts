import EventEmitter from 'events';

export const STATUS = {
  PROVISIONING: 'PROVISIONING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  FAILED: 'FAILED',
  OFFLINE: 'OFFLINE',
};

export interface LogEntry {
  type: 'daemon' | 'container' | 'process';
  line: string;
  ts: number;
}

/** How a provisioning run ended, for whoever asks after the lock is gone. */
export interface ProvisionOutcome {
  ok: boolean;
  error?: string;
  at: number;
}

export class ProvisioningManager extends EventEmitter {
  private locks = new Set<string>();
  private logBuffers = new Map<string, LogEntry[]>();
  /*
   * The lock alone cannot answer "did it work" — absent means finished, and finished
   * covers both outcomes equally. Migration needs the difference: the panel deletes
   * the source copy once the destination is provisioned, and a failure that looks
   * identical to a success is the one case that must not happen.
   */
  private outcomes = new Map<string, ProvisionOutcome>();

  isLocked(serverId: string): boolean {
    return this.locks.has(serverId);
  }

  /** How the last run for this server ended, or undefined if it has never run here. */
  lastOutcome(serverId: string): ProvisionOutcome | undefined {
    return this.outcomes.get(serverId);
  }

  emitLog(serverId: string, type: 'daemon' | 'container' | 'process', line: string) {
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
    this.outcomes.delete(serverId);
    try {
      await task();
      this.outcomes.set(serverId, { ok: true, at: Date.now() });
    } catch (err: any) {
      console.error(`[Provisioning Error] Server ${serverId} provisioning failed:`, err.message);
      this.emitLog(serverId, 'daemon', `[Daemon Error] ${err.message}`);
      this.emit('status', { serverId, status: STATUS.FAILED, error: err.message });
      this.outcomes.set(serverId, { ok: false, error: err.message, at: Date.now() });
      throw err;
    } finally {
      this.locks.delete(serverId);
    }
  }
}

export const provisioningManager = new ProvisioningManager();

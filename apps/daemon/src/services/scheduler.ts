import path from 'path';
import fs from 'fs';
import type { PrismaClient } from '@prisma/client';
import { ExecutionMode } from '@mc-manager/shared';
import { backupManager } from './backup/backup';
import { sendServerCommand } from './runtime/console';
import { stopServerContainer, startServerContainer } from './runtime/docker';
import { processManager } from './runtime/process';
import { loadConfig } from '../config';

// DATABASE_URL is optional for the daemon — schedules can also be triggered via
// the web panel's HTTP API. When not set, the scheduler silently skips DB polling.
// Required lazily, and tolerantly: the desktop build ships no Prisma engine at all,
// so an operator who sets DATABASE_URL there would otherwise crash the daemon on
// startup instead of just losing schedule polling. See routes/servers.ts for why
// the dependency is loaded this late.
function connectPrisma(): PrismaClient | null {
  if (!process.env.DATABASE_URL) return null;
  try {
    return new (require('@prisma/client').PrismaClient)() as PrismaClient;
  } catch {
    console.warn('[SchedulerService] DATABASE_URL is set but @prisma/client is unavailable; schedule polling stays off.');
    return null;
  }
}

const prisma = connectPrisma();
const DB_AVAILABLE = !!prisma;
const config = loadConfig();

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Schedule *firing* now lives in the web panel's monitor loop, which always has
   * DATABASE_URL. This daemon-side poller only ever ran when the daemon happened to be
   * given database credentials — in practice it never did, so schedules silently never
   * fired. Leaving it running would double-fire every schedule on any node that does
   * have DATABASE_URL set, so it stays off.
   *
   * executeSchedule() below is still used, by the manual "trigger now" endpoint.
   */
  public start(): void {
    console.log('[SchedulerService] Schedule polling is handled by the web panel; daemon poller disabled.');
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async tick(): Promise<void> {
    if (this.isRunning) return;
    if (!DB_AVAILABLE || !prisma) return; // No DB connection — skip silently
    this.isRunning = true;

    try {
      const now = new Date();
      const schedules = await prisma.serverSchedule.findMany({
        where: { isEnabled: true },
        include: { server: true },
      });

      for (const schedule of schedules) {
        try {
          if (this.shouldRunSchedule(schedule.cronExpression, schedule.lastRunAt, now)) {
            console.log(`[SchedulerService] Triggering schedule '${schedule.name}' (${schedule.actionType}) for server '${schedule.serverId}'...`);
            await this.executeSchedule(schedule);
          }
        } catch (scheduleErr: any) {
          console.error(`[SchedulerService] Error running schedule ${schedule.id}:`, scheduleErr.message);
        }
      }
    } catch (err: any) {
      console.warn(`[SchedulerService] Tick iteration warning: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  public async executeSchedule(schedule: any): Promise<void> {
    const now = new Date();
    const serverId = schedule.serverId;

    if (schedule.actionType === 'BACKUP') {
      const autoBackupName = `AutoBackup_${schedule.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${now.toISOString().slice(0, 10)}`;
      await backupManager.createBackup(serverId, autoBackupName);
    } else if (schedule.actionType === 'COMMAND' && schedule.payload) {
      await sendServerCommand(serverId, schedule.payload);
    } else if (schedule.actionType === 'START') {
      const isDocker = !serverId.startsWith('process-');
      const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${serverId}`) : serverId;
      if (isDocker) {
        await startServerContainer(containerId).catch(() => {});
      } else {
        const serverDir = path.join(config.dataDir, serverId);
        const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
        let dto: any = {
          serverId,
          mcVersion: schedule.server?.mcVersion || '1.20.1',
          serverPort: schedule.server?.serverPort || 25565,
          memoryMb: schedule.server?.memoryMb || 2048,
          cpuLimit: 1.0,
          eulaAccepted: true,
          serverType: schedule.server?.serverType || 'FABRIC',
          executionMode: ExecutionMode.PROCESS,
        };
        if (fs.existsSync(metaPath)) {
          try { dto = { ...dto, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (e) {}
        }
        await processManager.startProcess(dto).catch(() => {});
      }
      if (prisma) {
        await prisma.server.update({
          where: { id: serverId },
          data: { status: 'RUNNING' },
        }).catch(() => {});
      }
    } else if (schedule.actionType === 'RESTART') {
      const isDocker = !serverId.startsWith('process-');
      const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${serverId}`) : serverId;
      if (isDocker) {
        await stopServerContainer(containerId).catch(() => {});
        await startServerContainer(containerId).catch(() => {});
      } else {
        await processManager.stopProcess(serverId).catch(() => {});
        const serverDir = path.join(config.dataDir, serverId);
        const metaPath = path.join(serverDir, 'craftcontrol-meta.json');
        let dto: any = {
          serverId,
          mcVersion: schedule.server?.mcVersion || '1.20.1',
          serverPort: schedule.server?.serverPort || 25565,
          memoryMb: schedule.server?.memoryMb || 2048,
          cpuLimit: 1.0,
          eulaAccepted: true,
          serverType: schedule.server?.serverType || 'FABRIC',
          executionMode: ExecutionMode.PROCESS,
        };
        if (fs.existsSync(metaPath)) {
          try { dto = { ...dto, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (e) {}
        }
        await processManager.startProcess(dto).catch(() => {});
      }
      if (prisma) {
        await prisma.server.update({
          where: { id: serverId },
          data: { status: 'RUNNING' },
        }).catch(() => {});
      }
    } else if (schedule.actionType === 'STOP') {
      const isDocker = !serverId.startsWith('process-');
      const containerId = isDocker ? (serverId.startsWith('mc-server-') ? serverId : `mc-server-${serverId}`) : serverId;
      if (isDocker) {
        await stopServerContainer(containerId).catch(() => {});
      } else {
        await processManager.stopProcess(serverId).catch(() => {});
      }
      if (prisma) {
        await prisma.server.update({
          where: { id: serverId },
          data: { status: 'OFFLINE' },
        }).catch(() => {});
      }
    }

    // Update lastRunAt timestamp
    if (prisma) {
      await prisma.serverSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now },
      }).catch(() => {});
    }
  }

  private shouldRunSchedule(cronExpr: string, lastRunAt: Date | null, now: Date): boolean {
    if (!cronExpr) return false;

    // Prevent running multiple times within the same minute
    if (lastRunAt) {
      const diffMs = now.getTime() - new Date(lastRunAt).getTime();
      if (diffMs < 55000) return false;
    }

    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return false;

    const [minRule, hourRule, dayRule, monthRule, wdayRule] = parts;

    const minute = now.getMinutes();
    const hour = now.getHours();
    const day = now.getDate();
    const month = now.getMonth() + 1;
    const wday = now.getDay();

    return (
      this.matchCronPart(minRule, minute) &&
      this.matchCronPart(hourRule, hour) &&
      this.matchCronPart(dayRule, day) &&
      this.matchCronPart(monthRule, month) &&
      this.matchCronPart(wdayRule, wday)
    );
  }

  private matchCronPart(rule: string, val: number): boolean {
    if (rule === '*') return true;
    if (rule.startsWith('*/')) {
      const step = parseInt(rule.slice(2), 10);
      return !isNaN(step) && step > 0 && val % step === 0;
    }
    if (rule.includes(',')) {
      return rule.split(',').map(s => parseInt(s.trim(), 10)).includes(val);
    }
    const num = parseInt(rule, 10);
    return !isNaN(num) && num === val;
  }
}

export const schedulerService = new SchedulerService();

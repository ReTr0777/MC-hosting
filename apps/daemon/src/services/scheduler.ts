import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { ExecutionMode } from '@mc-manager/shared';
import { backupManager } from './backup';
import { sendServerCommand } from './console';
import { stopServerContainer, startServerContainer } from './docker';
import { processManager } from './process';
import { loadConfig } from '../config';

// DATABASE_URL is optional for the daemon — schedules can also be triggered via
// the web panel's HTTP API. When not set, the scheduler silently skips DB polling.
const DB_AVAILABLE = !!process.env.DATABASE_URL;
const prisma = DB_AVAILABLE ? new PrismaClient() : null;
const config = loadConfig();

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  public start(): void {
    if (this.timer) return;
    console.log('[SchedulerService] Starting background schedule manager (checking every 60s)...');
    this.timer = setInterval(() => this.tick(), 60000);
    // Initial tick after 5s startup
    setTimeout(() => this.tick(), 5000);
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

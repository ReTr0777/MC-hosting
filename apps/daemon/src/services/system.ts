import si from 'systeminformation';
import Docker from 'dockerode';
import { DaemonHealthDto } from '@mc-manager/shared';

const docker = new Docker();

export async function getSystemHealth(): Promise<DaemonHealthDto> {
  let dockerAvailable = false;
  try {
    await docker.ping();
    dockerAvailable = true;
  } catch (e) {
    dockerAvailable = false;
  }

  const [cpu, mem, time] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.time(),
  ]);

  return {
    status: dockerAvailable ? 'ok' : 'degraded',
    uptime: Math.floor(time.uptime),
    cpuUsage: Math.round(cpu.currentLoad * 100) / 100,
    memoryUsage: {
      used: Math.round(mem.active / (1024 * 1024)),
      total: Math.round(mem.total / (1024 * 1024)),
    },
    dockerAvailable,
  };
}

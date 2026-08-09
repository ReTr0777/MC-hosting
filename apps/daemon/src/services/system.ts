import si from 'systeminformation';
import Docker from 'dockerode';
import { DaemonHealthDto } from '@mc-manager/shared';

const docker = new Docker();

// Cache previous net stats for delta-based rx/tx calculations
let _prevNetStats: Awaited<ReturnType<typeof si.networkStats>> | null = null;
let _prevNetTime = Date.now();

export async function getSystemHealth(): Promise<DaemonHealthDto> {
  let dockerAvailable = false;
  try {
    await docker.ping();
    dockerAvailable = true;
  } catch (e) {
    dockerAvailable = false;
  }

  const [cpu, mem, time, cpuInfo, fsSize, osInfo, netStats, netIfaces, cpuTemp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.time(),
    si.cpu(),
    si.fsSize(),
    si.osInfo(),
    si.networkStats(),
    si.networkInterfaces(),
    si.cpuTemperature().catch(() => ({ main: null })),
  ]);

  // --- Disk usage ---
  const diskUsage = fsSize
    .filter((fs) => fs.size > 0 && fs.used !== null)
    .map((fs) => ({
      mount: fs.mount,
      used: Math.round(fs.used / (1024 * 1024 * 1024) * 10) / 10,
      free: Math.round(fs.available / (1024 * 1024 * 1024) * 10) / 10,
      total: Math.round(fs.size / (1024 * 1024 * 1024) * 10) / 10,
      usedPercent: Math.round((fs.use ?? 0) * 10) / 10,
    }))
    .slice(0, 6);

  // --- Network: ip4 + speed come from networkInterfaces(), rx/tx from networkStats() ---
  const now = Date.now();
  const elapsed = Math.max((now - _prevNetTime) / 1000, 0.1);

  const ifaceArr = Array.isArray(netIfaces) ? netIfaces : [netIfaces];
  const ifaceMap: Record<string, { ip4: string; speed: number }> = {};
  for (const iface of ifaceArr) {
    if (iface.iface) {
      ifaceMap[iface.iface] = { ip4: iface.ip4 || '', speed: iface.speed ?? 0 };
    }
  }

  const networkInterfaces = netStats
    .filter((n) => n.iface && ifaceMap[n.iface]?.ip4)
    .map((n) => {
      const prev = _prevNetStats?.find((p) => p.iface === n.iface);
      const rxDelta = prev ? Math.max(0, n.rx_bytes - prev.rx_bytes) : 0;
      const txDelta = prev ? Math.max(0, n.tx_bytes - prev.tx_bytes) : 0;
      return {
        iface: n.iface,
        ip4: ifaceMap[n.iface]?.ip4 ?? '',
        speed: ifaceMap[n.iface]?.speed ?? 0,
        rx_sec: Math.round(rxDelta / elapsed),
        tx_sec: Math.round(txDelta / elapsed),
      };
    })
    .slice(0, 4);

  _prevNetStats = netStats;
  _prevNetTime = now;

  return {
    status: dockerAvailable ? 'ok' : 'degraded',
    uptime: Math.floor(time.uptime),
    cpuUsage: Math.round(cpu.currentLoad * 100) / 100,
    memoryUsage: {
      used: Math.round(mem.active / (1024 * 1024)),
      total: Math.round(mem.total / (1024 * 1024)),
      free: Math.round(mem.available / (1024 * 1024)),
      swapUsed: Math.round(mem.swapused / (1024 * 1024)),
      swapTotal: Math.round(mem.swaptotal / (1024 * 1024)),
    },
    dockerAvailable,
    cpuModel: `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim(),
    cpuCores: cpuInfo.physicalCores,
    cpuThreads: cpuInfo.cores,
    cpuTemp: typeof cpuTemp.main === 'number' ? Math.round(cpuTemp.main * 10) / 10 : null,
    diskUsage,
    osInfo: {
      platform: osInfo.platform,
      distro: osInfo.distro,
      arch: osInfo.arch,
      kernel: osInfo.kernel,
      hostname: osInfo.hostname,
    },
    networkInterfaces,
  };
}

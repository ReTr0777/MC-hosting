import os from 'os';
import si from 'systeminformation';
import Docker from 'dockerode';
import { DaemonHealthDto, DEFAULT_ENABLED_GAMES } from '@mc-manager/shared';
import { getConfig } from '../config';
import { detectBestJavaMajor } from './runtime/java-version';

const docker = new Docker();

// Cache previous net stats for delta-based rx/tx calculations
let _prevNetStats: Awaited<ReturnType<typeof si.networkStats>> | null = null;
let _prevNetTime = Date.now();

/*
 * Health is polled, so it has to be cheap — and on Windows it very much was not.
 *
 * Several systeminformation calls shell out to PowerShell there, and starting an
 * interpreter costs hundreds of milliseconds of CPU each time. The panel polls every
 * node every five seconds, every open dashboard tab runs its own loop, and each poll
 * used to run nine of these from scratch. Slow replies then overran the panel's
 * timeout, which retried, which started more of them: a laptop ended up at 70% CPU
 * with a pile of PowerShell processes, and the node it was hosting flickered offline
 * because its own health check was what kept it busy.
 *
 * Two things fix it. Concurrent callers share one computation instead of each starting
 * their own, which is what stops the pile-up; and a short cache means a burst of polls
 * costs one measurement rather than one each.
 */
const HEALTH_TTL_MS = 4_000;
/** Facts about the machine that do not change while it is running. */
const STATIC_TTL_MS = 10 * 60_000;
/** Slowest call by far on Windows, and the least important thing on the page. */
const TEMP_TTL_MS = 60_000;

let healthCache: { at: number; value: DaemonHealthDto } | null = null;
let healthInFlight: Promise<DaemonHealthDto> | null = null;

function cached<T>(ttlMs: number, load: () => Promise<T>) {
  let at = 0;
  let value: T | null = null;
  let inFlight: Promise<T> | null = null;
  return async (): Promise<T> => {
    if (value !== null && Date.now() - at < ttlMs) return value;
    if (inFlight) return inFlight;
    inFlight = load()
      .then((result) => {
        value = result;
        at = Date.now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

const cpuInfoCached = cached(STATIC_TTL_MS, () => si.cpu());
const osInfoCached = cached(STATIC_TTL_MS, () => si.osInfo());
const cpuTempCached = cached(TEMP_TTL_MS, () => si.cpuTemperature().catch(() => ({ main: null as number | null })));

/*
 * Everything below is measured on a timescale that suits what it describes, because on
 * Windows each of these shells out and none of them is cheap. Timed on a desktop:
 * networkStats 3.5s, networkInterfaces 1.4s, fsSize 0.8s, mem 0.9s. Running that set on
 * every poll is what put a laptop at 50% CPU.
 *
 * The network figures are the extreme case — the panel reads no part of them, so they
 * cost seconds per poll to produce something nothing displays.
 */
const SLOW_TTL_MS = 60_000;

/*
 * Each of these falls back rather than rejecting. They are extras on a page — a disk
 * list, a swap figure, a network rate — and a node that cannot read one of them is
 * still a node. Letting the failure through would fail the whole health check, which
 * the panel reads as the node being down: the least useful stat on the page taking
 * the node offline.
 */
const fsSizeCached = cached(SLOW_TTL_MS, () => si.fsSize().catch(() => [] as Awaited<ReturnType<typeof si.fsSize>>));
/** Only swap is taken from here; the live totals come from os, which costs nothing. */
const swapCached = cached(SLOW_TTL_MS, () => si.mem().catch(() => ({ swapused: 0, swaptotal: 0 } as Awaited<ReturnType<typeof si.mem>>)));
const netCached = cached(SLOW_TTL_MS, async () => {
  const [stats, ifaces] = await Promise.all([
    si.networkStats().catch(() => [] as Awaited<ReturnType<typeof si.networkStats>>),
    si.networkInterfaces().catch(() => [] as Awaited<ReturnType<typeof si.networkInterfaces>>),
  ]);
  return { stats, ifaces };
});

/*
 * Live CPU without a subprocess.
 *
 * os.cpus() reports cumulative busy and idle ticks, so the load over an interval is the
 * ratio of their deltas. si.currentLoad() computes the same thing by asking Windows,
 * which costs half a second; this costs microseconds and needs no cache at all.
 */
let prevTicks: { idle: number; total: number } | null = null;

function readTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const core of os.cpus()) {
    for (const [kind, ticks] of Object.entries(core.times) as [string, number][]) {
      total += ticks;
      if (kind === 'idle') idle += ticks;
    }
  }
  return { idle, total };
}

function cpuUsagePercent(): number {
  const now = readTicks();
  const prev = prevTicks;
  prevTicks = now;
  // Nothing to compare against on the first call, and no history to invent.
  if (!prev) return 0;

  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0) return 0;

  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

export async function getSystemHealth(): Promise<DaemonHealthDto> {
  const fresh = healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS;
  if (fresh && healthCache) return healthCache.value;
  if (healthInFlight) return healthInFlight;

  healthInFlight = collectSystemHealth()
    .then((value) => {
      healthCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      healthInFlight = null;
    });

  return healthInFlight;
}

async function collectSystemHealth(): Promise<DaemonHealthDto> {
  let dockerAvailable = false;
  try {
    await docker.ping();
    dockerAvailable = true;
  } catch (e) {
    dockerAvailable = false;
  }

  // The live figures come from os: exact, instant, and no process spawned.
  const cpuUsage = cpuUsagePercent();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const uptimeSeconds = os.uptime();

  const [cpuInfo, fsSize, osInfo, net, cpuTemp, swap, javaMajor] = await Promise.all([
    cpuInfoCached(),
    fsSizeCached(),
    osInfoCached(),
    netCached(),
    cpuTempCached(),
    swapCached(),
    // Probed once for the life of the process and cached there, so this is free after
    // the first health check. See detectBestJavaMajor.
    detectBestJavaMajor(),
  ]);
  const { stats: netStats, ifaces: netIfaces } = net;

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
    uptime: Math.floor(uptimeSeconds),
    cpuUsage: Math.round(cpuUsage * 100) / 100,
    memoryUsage: {
      used: Math.round((totalBytes - freeBytes) / (1024 * 1024)),
      total: Math.round(totalBytes / (1024 * 1024)),
      free: Math.round(freeBytes / (1024 * 1024)),
      swapUsed: Math.round(swap.swapused / (1024 * 1024)),
      swapTotal: Math.round(swap.swaptotal / (1024 * 1024)),
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
    // Piggybacks on the existing 5s ping so the panel's node picker stays current
    // without a second round trip. See api/nodes/[id]/ping/route.ts.
    enabledGames: getConfig().enabledGames ?? [...DEFAULT_ENABLED_GAMES],
    javaMajor,
  };
}

'use client';

import React, { useEffect, useState } from 'react';

interface StatsData {
  cpuPercent: number;
  memoryMb: number;
  history: Array<{ timestamp: string; cpuPercent: number; memoryMb: number }>;
}

export default function AnalyticsWidget({ serverId, memoryLimitMb }: { serverId: string; memoryLimitMb: number }) {
  const [stats, setStats] = useState<StatsData>({ cpuPercent: 0, memoryMb: 0, history: [] });

  useEffect(() => {
    let isMounted = true;
    const fetchStats = async () => {
      try {
        const res = await fetch(`/api/servers/${serverId}/stats`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setStats(data);
        }
      } catch (e) {}
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [serverId]);

  const memoryPercent = Math.min(100, Math.round((stats.memoryMb / (memoryLimitMb || 4096)) * 100));
  const cpuClamped = Math.min(100, stats.cpuPercent);
  const cpuWarn = cpuClamped > 80;
  const memWarn = memoryPercent > 80;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '4px' }}>
      {/* CPU Card */}
      <div className="cc-card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            CPU Usage
          </span>
          <span style={{
            fontSize: '1.1rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            color: cpuWarn ? 'var(--warning)' : 'var(--accent)',
          }}>
            {stats.cpuPercent.toFixed(1)}%
          </span>
        </div>
        <div className="cc-bar-track">
          <div
            className={`cc-bar-fill${cpuWarn ? ' cc-bar-fill-warn' : ''}`}
            style={{ width: `${cpuClamped}%` }}
          />
        </div>
      </div>

      {/* RAM Card */}
      <div className="cc-card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            RAM Consumption
          </span>
          <span style={{
            fontSize: '0.875rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            color: memWarn ? 'var(--warning)' : 'var(--accent)',
          }}>
            {stats.memoryMb} MB{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.75rem' }}>
              / {memoryLimitMb} MB ({memoryPercent}%)
            </span>
          </span>
        </div>
        <div className="cc-bar-track">
          <div
            className={`cc-bar-fill${memWarn ? ' cc-bar-fill-warn' : ''}`}
            style={{ width: `${memoryPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
}

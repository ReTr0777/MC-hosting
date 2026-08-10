'use client';

import React, { useEffect, useState } from 'react';

interface Sample {
  cpuPercent: number;
  memoryMb: number;
  playerCount: number | null;
  createdAt: string;
}

const RANGES: Array<{ key: '1h' | '24h' | '7d'; label: string }> = [
  { key: '1h', label: '1 Hour' },
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
];

function buildPath(values: number[], width: number, height: number, max: number): string {
  if (values.length === 0) return '';
  if (values.length === 1) {
    const y = height - (values[0] / max) * height;
    return `M0,${y.toFixed(1)} L${width},${y.toFixed(1)}`;
  }
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - (max > 0 ? (v / max) * height : 0);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function Sparkline({ values, max, color, unit }: { values: number[]; max: number; color: string; unit: string }) {
  const width = 100;
  const height = 32;
  const path = buildPath(values, width, height, max);
  const latest = values.length ? values[values.length - 1] : 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {unit === '%' ? 'CPU' : 'RAM'}
        </span>
        <span style={{ fontSize: '0.8125rem', fontFamily: 'var(--font-mono)', fontWeight: 700, color }}>
          {latest.toFixed(unit === '%' ? 1 : 0)}{unit}
        </span>
      </div>
      {values.length > 1 ? (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: '40px', display: 'block' }}>
          <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '10px 0' }}>Not enough data yet in this range</div>
      )}
    </div>
  );
}

export default function ResourceHistoryChart({ serverId }: { serverId: string }) {
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('1h');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/servers/${serverId}/stats/history?range=${range}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSamples(Array.isArray(data.samples) ? data.samples : []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, range]);

  const cpuValues = samples.map((s) => s.cpuPercent);
  const memValues = samples.map((s) => s.memoryMb);
  const maxCpu = Math.max(100, ...cpuValues);
  const maxMem = Math.max(512, ...memValues);

  return (
    <div className="cc-card" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Resource History
        </span>
        <div style={{ display: 'flex', gap: '4px' }}>
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              style={{
                fontSize: '0.7rem',
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: range === r.key ? 'var(--accent)' : 'transparent',
                color: range === r.key ? '#0d1117' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '12px 0' }}>Loading history...</div>
      ) : samples.length === 0 ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '12px 0' }}>
          No history recorded yet for this range. Samples are captured while the server is running.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <Sparkline values={cpuValues} max={maxCpu} color="var(--accent)" unit="%" />
          <Sparkline values={memValues} max={maxMem} color="#60a5fa" unit=" MB" />
        </div>
      )}
    </div>
  );
}

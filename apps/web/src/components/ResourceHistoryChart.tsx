'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

interface Sample {
  cpuPercent: number;
  memoryMb: number;
  playerCount: number | null;
  createdAt: string;
}

type RangeKey = '1h' | '24h' | '7d';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '1h', label: '1 Hour' },
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
];

const CPU_COLOR = 'var(--accent)';
const MEM_COLOR = '#60a5fa';
const PLAYERS_COLOR = '#818cf8';

function niceMax(value: number): number {
  if (!isFinite(value) || value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatTime(iso: string, range: RangeKey): string {
  const d = new Date(iso);
  if (range === '7d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface ChartPanelProps {
  title: string;
  values: number[];
  timestamps: string[];
  color: string;
  max: number;
  formatValue: (v: number) => string;
  range: RangeKey;
  hoverIndex: number | null;
  onHoverIndex: (i: number | null) => void;
  refLine?: { value: number; label: string } | null;
}

const WIDTH = 600;
const HEIGHT = 128;
const PAD_LEFT = 34;
const PAD_BOTTOM = 16;
const PAD_TOP = 8;
const PLOT_W = WIDTH - PAD_LEFT;
const PLOT_H = HEIGHT - PAD_BOTTOM - PAD_TOP;

function ChartPanel({ title, values, timestamps, color, max, formatValue, range, hoverIndex, onHoverIndex, refLine }: ChartPanelProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const points = useMemo(() => {
    if (values.length === 0) return [] as Array<{ x: number; y: number }>;
    const step = values.length > 1 ? PLOT_W / (values.length - 1) : 0;
    return values.map((v, i) => ({
      x: PAD_LEFT + i * step,
      y: PAD_TOP + PLOT_H - (max > 0 ? (v / max) * PLOT_H : 0),
    }));
  }, [values, max]);

  const linePath = points.length
    ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    : '';
  const baseline = PAD_TOP + PLOT_H;
  const areaPath =
    points.length > 1
      ? `${linePath} L${points[points.length - 1].x.toFixed(1)},${baseline.toFixed(1)} L${points[0].x.toFixed(1)},${baseline.toFixed(1)} Z`
      : '';

  const gridFractions = [0, 0.5, 1];

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current || values.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dataX = fraction * WIDTH - PAD_LEFT;
    const dataFraction = Math.min(1, Math.max(0, dataX / PLOT_W));
    const idx = Math.round(dataFraction * (values.length - 1));
    onHoverIndex(Math.min(values.length - 1, Math.max(0, idx)));
  };

  const latest = values.length ? values[values.length - 1] : null;
  const hovered = hoverIndex !== null && hoverIndex < values.length ? values[hoverIndex] : null;
  const hoveredPoint = hoverIndex !== null ? points[hoverIndex] ?? null : null;
  const refY = refLine ? PAD_TOP + PLOT_H - (Math.min(refLine.value, max) / max) * PLOT_H : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {title}
        </span>
        <span style={{ fontSize: '0.8125rem', fontFamily: 'var(--font-mono)', fontWeight: 700, color }}>
          {formatValue(hovered ?? latest ?? 0)}
        </span>
      </div>

      {values.length === 0 ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '28px 0', textAlign: 'center' }}>
          Not enough data yet in this range
        </div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '116px', display: 'block', cursor: values.length > 1 ? 'crosshair' : 'default', touchAction: 'none' }}
          onPointerMove={handleMove}
          onPointerLeave={() => onHoverIndex(null)}
        >
          {gridFractions.map((f) => {
            const y = PAD_TOP + PLOT_H * (1 - f);
            return <line key={f} x1={PAD_LEFT} y1={y} x2={WIDTH} y2={y} stroke="var(--border)" strokeWidth="1" />;
          })}

          <text x={PAD_LEFT - 5} y={PAD_TOP + 3} textAnchor="end" fontSize="9" fill="var(--text-muted)">{formatValue(max)}</text>
          <text x={PAD_LEFT - 5} y={baseline} textAnchor="end" fontSize="9" fill="var(--text-muted)">0</text>

          {refLine && refY !== null && (
            <>
              <line x1={PAD_LEFT} y1={refY} x2={WIDTH} y2={refY} stroke="var(--warning)" strokeWidth="1" opacity="0.55" />
              <text x={WIDTH} y={refY - 3} textAnchor="end" fontSize="9" fill="var(--warning)">{refLine.label}</text>
            </>
          )}

          {areaPath && <path d={areaPath} fill={color} opacity="0.1" stroke="none" />}
          {linePath && (
            <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          )}

          {hoveredPoint && (
            <>
              <line x1={hoveredPoint.x} y1={PAD_TOP} x2={hoveredPoint.x} y2={baseline} stroke="var(--text-muted)" strokeWidth="1" opacity="0.4" />
              <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="4" fill={color} stroke="var(--surface)" strokeWidth="2" />
            </>
          )}

          {timestamps.length > 0 && (
            <>
              <text x={PAD_LEFT} y={HEIGHT - 2} textAnchor="start" fontSize="9" fill="var(--text-muted)">{formatTime(timestamps[0], range)}</text>
              <text x={WIDTH} y={HEIGHT - 2} textAnchor="end" fontSize="9" fill="var(--text-muted)">{formatTime(timestamps[timestamps.length - 1], range)}</text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}

export default function ResourceHistoryChart({ serverId, memoryLimitMb }: { serverId: string; memoryLimitMb?: number }) {
  const [range, setRange] = useState<RangeKey>('1h');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

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
      setHoverIndex(null);
    };
  }, [serverId, range]);

  const timestamps = samples.map((s) => s.createdAt);
  const cpuValues = samples.map((s) => s.cpuPercent);
  const memValues = samples.map((s) => s.memoryMb);
  const hasPlayerData = samples.some((s) => s.playerCount !== null);
  const playerValues = samples.map((s) => s.playerCount ?? 0);

  const maxCpu = niceMax(Math.max(100, ...cpuValues));
  const maxMem = niceMax(Math.max(memoryLimitMb ?? 0, ...memValues, 512));
  const maxPlayers = niceMax(Math.max(4, ...playerValues));

  const hoveredSample = hoverIndex !== null ? samples[hoverIndex] : null;

  return (
    <div className="cc-card" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Resource History
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {samples.length > 0 && (
            <button
              onClick={() => setShowTable((v) => !v)}
              style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {showTable ? 'Hide table' : 'View as table'}
            </button>
          )}
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
      </div>

      {samples.length === 0 && !loading ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '12px 0' }}>
          No history recorded yet for this range. Samples are captured while the server is running.
        </div>
      ) : (
        <div style={{ opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {/* Shared hover readout — one line, every series, so the reader never has to land on a specific line */}
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '10px', fontFamily: 'var(--font-mono)', minHeight: '14px' }}>
            {hoveredSample ? (
              <>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{formatFull(hoveredSample.createdAt)}</span>
                {' — '}
                <span style={{ color: CPU_COLOR }}>{hoveredSample.cpuPercent.toFixed(1)}% CPU</span>
                {' · '}
                <span style={{ color: MEM_COLOR }}>{Math.round(hoveredSample.memoryMb)} MB RAM</span>
                {hasPlayerData && hoveredSample.playerCount !== null && (
                  <>
                    {' · '}
                    <span style={{ color: PLAYERS_COLOR }}>{hoveredSample.playerCount} players</span>
                  </>
                )}
              </>
            ) : (
              'Hover any chart to inspect a point in time'
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: hasPlayerData ? '1fr 1fr 1fr' : '1fr 1fr', gap: '20px' }}>
            <ChartPanel
              title="CPU"
              values={cpuValues}
              timestamps={timestamps}
              color={CPU_COLOR}
              max={maxCpu}
              formatValue={(v) => `${v.toFixed(1)}%`}
              range={range}
              hoverIndex={hoverIndex}
              onHoverIndex={setHoverIndex}
            />
            <ChartPanel
              title="RAM"
              values={memValues}
              timestamps={timestamps}
              color={MEM_COLOR}
              max={maxMem}
              formatValue={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`)}
              range={range}
              hoverIndex={hoverIndex}
              onHoverIndex={setHoverIndex}
              refLine={memoryLimitMb ? { value: memoryLimitMb, label: 'Limit' } : null}
            />
            {hasPlayerData && (
              <ChartPanel
                title="Players"
                values={playerValues}
                timestamps={timestamps}
                color={PLAYERS_COLOR}
                max={maxPlayers}
                formatValue={(v) => `${Math.round(v)}`}
                range={range}
                hoverIndex={hoverIndex}
                onHoverIndex={setHoverIndex}
              />
            )}
          </div>

          {showTable && (
            <div style={{ marginTop: '16px', maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Time</th>
                    <th style={{ textAlign: 'right', padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>CPU</th>
                    <th style={{ textAlign: 'right', padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>RAM</th>
                    {hasPlayerData && <th style={{ textAlign: 'right', padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Players</th>}
                  </tr>
                </thead>
                <tbody>
                  {[...samples].reverse().map((s, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{formatFull(s.createdAt)}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-primary)' }}>{s.cpuPercent.toFixed(1)}%</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-primary)' }}>{Math.round(s.memoryMb)} MB</td>
                      {hasPlayerData && (
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-primary)' }}>{s.playerCount ?? '—'}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
